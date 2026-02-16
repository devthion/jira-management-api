import { Injectable, UnauthorizedException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

interface JiraIssue {
  id: string;
  key: string;
  fields?: {
    summary?: string;
    assignee?: unknown;
    worklog?: {
      startAt: number;
      maxResults: number;
      total: number;
      worklogs: JiraWorklog[];
    };
  };
}

export interface JiraWorklog {
  author: {
    accountId?: string;
    emailAddress?: string;
    displayName?: string;
  };
  timeSpentSeconds: number;
  started?: string;
  created?: string;
}

interface AccessibleResource {
  id: string;
  scopes?: string[];
}

interface HttpError {
  response?: {
    status?: number;
    data?: unknown;
  };
  message?: string;
}

@Injectable()
export class JiraService {
  private readonly atlassianApiUrl = 'https://api.atlassian.com';

  constructor(private readonly http: HttpService) {}

  /**
   * Obtiene el cloudId del usuario usando el access token OAuth
   */
  private async getCloudId(accessToken: string): Promise<string> {
    const url = `${this.atlassianApiUrl}/oauth/token/accessible-resources`;
    try {
      const response = await firstValueFrom(
        this.http.get<AccessibleResource[]>(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
        }),
      );

      const resources = response.data;
      if (!resources || resources.length === 0) {
        throw new UnauthorizedException('No accessible Jira resources found for this token');
      }

      // Buscar el recurso de tipo 'jira'
      const jiraResource = resources.find((r) => r.scopes?.includes('read:jira-work'));
      if (!jiraResource) {
        throw new UnauthorizedException('No Jira resource found with required scopes');
      }

      return jiraResource.id;
    } catch (error) {
      const httpError = error as HttpError;
      if (httpError.response?.status === 401 || httpError.response?.status === 403) {
        throw new UnauthorizedException('Invalid or expired access token');
      }
      console.error('[Jira Error][getCloudId]', httpError.response?.data || httpError.message);
      throw new Error(
        `Failed to get cloudId: ${httpError.response?.status} - ${JSON.stringify(
          httpError.response?.data || httpError.message,
        )}`,
      );
    }
  }

  /**
   * Construye la URL base de Jira usando el cloudId
   */
  private getJiraBaseUrl(cloudId: string): string {
    return `${this.atlassianApiUrl}/ex/jira/${cloudId}/rest/api/3`;
  }

  /**
   * Obtiene los headers de autenticación con Bearer token
   */
  private getAuthHeader(accessToken: string) {
    return {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    };
  }

  /**
   * Obtiene issues por JQL. Usa POST /rest/api/3/search/jql (único endpoint disponible).
   * Este endpoint NO soporta paginación: devuelve como máximo ~50 issues por request.
   * Por eso dividimos el rango en días (getIssuesWithDateRangeSplit) para obtener más issues.
   */
  async getIssues(jql: string, accessToken: string, cloudId: string): Promise<JiraIssue[]> {
    const baseUrl = this.getJiraBaseUrl(cloudId);
    const url = `${baseUrl}/search/jql`;

    try {
      const response = await firstValueFrom(
        this.http.post<{ issues: JiraIssue[] }>(
          url,
          {
            jql,
            fields: ['summary', 'assignee', 'worklog'],
          },
          { headers: this.getAuthHeader(accessToken) },
        ),
      );

      return response.data.issues || [];
    } catch (error) {
      const httpError = error as HttpError;
      if (httpError.response?.status === 401 || httpError.response?.status === 403) {
        throw new UnauthorizedException('Invalid or expired access token');
      }
      console.error('[Jira Error][getIssues]', httpError.response?.data || httpError.message);
      throw new Error(
        `Jira API error (${httpError.response?.status}): ${JSON.stringify(
          httpError.response?.data || httpError.message,
        )}`,
      );
    }
  }

  async getWorklogs(issueKey: string, accessToken: string, cloudId: string): Promise<JiraWorklog[]> {
    const baseUrl = this.getJiraBaseUrl(cloudId);
    const allWorklogs: JiraWorklog[] = [];
    let startAt = 0;
    const maxResults = 1000; // Máximo permitido por Jira API

    try {
      while (true) {
        const url = `${baseUrl}/issue/${issueKey}/worklog?startAt=${startAt}&maxResults=${maxResults}`;
        const response = await firstValueFrom(
          this.http.get<{
            worklogs: JiraWorklog[];
            total: number;
            startAt: number;
            maxResults: number;
          }>(url, {
            headers: this.getAuthHeader(accessToken),
          }),
        );

        const worklogs = response.data.worklogs || [];
        allWorklogs.push(...worklogs);

        // Si ya obtuvimos todos los worklogs, salir del loop
        if (allWorklogs.length >= response.data.total || worklogs.length < maxResults) {
          break;
        }

        startAt += maxResults;
      }

      return allWorklogs;
    } catch (error) {
      const httpError = error as HttpError;
      if (httpError.response?.status === 401 || httpError.response?.status === 403) {
        throw new UnauthorizedException('Invalid or expired access token');
      }
      console.error('[Jira Error][getWorklogs]', httpError.response?.data || httpError.message);
      return [];
    }
  }

  /**
   * Construye el JQL optimizado para buscar issues con worklogs en un rango de fechas.
   * IMPORTANTE: Limita por fecha de creación del issue para evitar traer issues muy antiguos.
   * Usamos worklogDate con un rango amplio (1 mes antes/después) para:
   * 1. Reducir la cantidad de issues a procesar (optimización)
   * 2. Capturar issues que puedan tener worklogs en el rango aunque su última fecha sea diferente
   * 3. El filtrado exacto por fecha se hace después en isWorklogInDateRange
   *
   * Estrategia:
   * - Si hay fechas: usar worklogDate con rango amplio para pre-filtrar
   * - Agregar filtro por fecha de creación del issue (created) para limitar a issues recientes
   * - Si hay JQL base: combinarlo con los filtros
   * - El filtrado final preciso se hace después obteniendo los worklogs
   */
  private buildJql(
    baseJql?: string,
    from?: string,
    to?: string,
    projectKey?: string,
    expandWorklogDateRange = true,
    username?: string,
  ): string {
    let jql = baseJql?.trim() || '';
    const filters: string[] = [];

    // Si se proporciona username, filtrar por worklogAuthor en el JQL
    if (username && username !== 'undefined') {
      filters.push(`worklogAuthor = ${username}`);
    }

    // Si se proporciona projectKey y no está en el JQL base, agregarlo
    if (projectKey && projectKey !== 'undefined' && !jql.toLowerCase().includes('project')) {
      filters.push(`project = ${projectKey}`);
    }

    // Si se proporcionan fechas, agregar filtros de worklogDate
    // Si expandWorklogDateRange es true, expandir el rango para capturar issues cercanos
    // Si es false (cuando dividimos en sub-rangos), usar el rango exacto para evitar solapamientos
    if (from || to) {
      if (from) {
        if (expandWorklogDateRange) {
          // Expandir 30 días antes para capturar issues con worklogs anteriores
          const fromExpanded = this.subtractDays(from, 30);
          filters.push(`worklogDate >= "${fromExpanded}"`);
        } else {
          // Usar el rango exacto sin expandir (para evitar solapamientos en sub-rangos)
          filters.push(`worklogDate >= "${from}"`);
        }
      }

      if (to) {
        if (expandWorklogDateRange) {
          // Expandir 30 días después para capturar issues con worklogs posteriores
          const toExpanded = this.addDays(to, 30);
          filters.push(`worklogDate <= "${toExpanded}"`);
        } else {
          // Usar el rango exacto sin expandir
          filters.push(`worklogDate <= "${to}"`);
        }
      }

      // Límite de antigüedad del issue (created): incluir issues creados hasta 1 año antes del rango
      // Así entran tareas viejas (ej. SS-19 creada en oct) que tienen worklogs recientes en el rango
      const today = new Date().toISOString().split('T')[0];
      const issueCreatedLookbackDays = 365; // 1 año
      const createdLimit = from
        ? this.subtractDays(from, issueCreatedLookbackDays)
        : this.subtractDays(today, issueCreatedLookbackDays);
      filters.push(`created >= "${createdLimit}"`);
    } else if (!jql) {
      // Si no hay fechas ni JQL personalizado: últimos 30 días de worklog, issues creados en el último año
      const today = new Date().toISOString().split('T')[0];
      const oneYearAgo = this.subtractDays(today, 365);
      filters.push('worklogDate >= -30d');
      filters.push(`created >= "${oneYearAgo}"`);
    }

    // Combinar todos los filtros
    if (filters.length > 0) {
      const filtersStr = filters.join(' AND ');
      jql = jql ? `${jql} AND ${filtersStr}` : filtersStr;
    }

    // Agregar ORDER BY solo si hay contenido
    if (jql) {
      jql = `${jql} ORDER BY created DESC`;
    }

    return jql;
  }

  /**
   * Normaliza una fecha a YYYY-MM-DD. Acepta:
   * - YYYY-MM-DD (se devuelve igual)
   * - DD-MM-YYYY o DD/MM/YYYY (europeo) → se convierte a YYYY-MM-DD
   */
  private normalizeToYYYYMMDD(dateStr: string | undefined): string | undefined {
    if (!dateStr || typeof dateStr !== 'string') return dateStr;
    const trimmed = dateStr.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const parts = trimmed.split(/[-/]/);
    if (parts.length === 3 && parts[0].length <= 2 && parts[1].length <= 2 && parts[2].length === 4) {
      const [d, m, y] = parts;
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    return trimmed;
  }

  /**
   * Resta días de una fecha en formato YYYY-MM-DD
   */
  private subtractDays(dateStr: string, days: number): string {
    const date = new Date(dateStr);
    date.setDate(date.getDate() - days);
    return date.toISOString().split('T')[0];
  }

  /**
   * Suma días a una fecha en formato YYYY-MM-DD
   */
  private addDays(dateStr: string, days: number): string {
    const date = new Date(dateStr);
    date.setDate(date.getDate() + days);
    return date.toISOString().split('T')[0];
  }

  /**
   * Devuelve el día siguiente en YYYY-MM-DD (evita bugs de timezone al iterar)
   */
  private nextDay(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00.000Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().split('T')[0];
  }

  /**
   * Obtiene issues dividiendo el rango de fechas en consultas individuales por día
   * Estrategia: Hacer una consulta por cada día del rango (from=to=día) y luego unir resultados
   * Esto evita el límite de 50 issues y garantiza que obtengamos todos los issues
   */
  /**
   * Días extra al buscar issues por rango (hacia atrás y hacia adelante).
   * Jira filtra worklogDate por fecha de CREACIÓN del worklog; nosotros mostramos por STARTED (fecha trabajada).
   * Si alguien trabaja el 26 pero carga las horas el 27, el issue solo sale en worklogDate=27.
   * Ampliando la búsqueda capturamos esos issues; luego filtramos worklogs por started en [from, to].
   */
  private static readonly WORKLOG_DATE_RANGE_LOOKBACK_DAYS = 7;

  private async getIssuesWithDateRangeSplit(
    baseJql: string | undefined,
    from: string,
    to: string,
    projectKey: string | undefined,
    accessToken: string,
    cloudId: string,
    username?: string,
  ): Promise<JiraIssue[]> {
    const allIssues: JiraIssue[] = [];
    const uniqueIssueKeys = new Set<string>();

    // Ampliar rango: (from - 7) hasta (to + 7) para capturar worklogs "created" antes/después pero "started" en [from, to]
    const effectiveFrom = this.subtractDays(from, JiraService.WORKLOG_DATE_RANGE_LOOKBACK_DAYS);
    const effectiveTo = this.addDays(to, JiraService.WORKLOG_DATE_RANGE_LOOKBACK_DAYS);
    let dateStr = effectiveFrom;

    while (dateStr <= effectiveTo) {
      const jql = this.buildJql(baseJql, dateStr, dateStr, projectKey, false, username);
      const issues = await this.getIssues(jql, accessToken, cloudId);

      for (const issue of issues) {
        if (!uniqueIssueKeys.has(issue.key)) {
          uniqueIssueKeys.add(issue.key);
          allIssues.push(issue);
        }
      }

      if (dateStr === effectiveTo) break;
      dateStr = this.nextDay(dateStr);
    }

    return allIssues;
  }

  /**
   * Filtra un worklog por la fecha en que se trabajaron las horas (started),
   * no por la fecha en que se cargaron en Jira (created).
   */
  private isWorklogInDateRange(worklog: JiraWorklog, from?: string, to?: string): boolean {
    if (!from && !to) return true;

    const worklogDate = worklog.started;
    if (!worklogDate) return false;

    const dateStr = worklogDate.split('T')[0]; // YYYY-MM-DD

    if (from && dateStr < from) return false;
    if (to && dateStr > to) return false;

    return true;
  }

  /**
   * Devuelve el total de horas logueadas por usuario,
   * basándose en los worklogs de los issues obtenidos.
   * Filtra los worklogs por rango de fechas si se proporcionan.
   */
  async getHoursByUser(
    accessToken: string,
    options: {
      jql?: string;
      from?: string;
      to?: string;
      username?: string;
      projectKey?: string;
    } = {},
  ) {
    const { jql: baseJql, username } = options;
    let { from, to, projectKey } = options;
    from = this.normalizeToYYYYMMDD(from);
    to = this.normalizeToYYYYMMDD(to);

    // Corregir projectKey si viene como string "undefined"
    if (projectKey === 'undefined' || projectKey === undefined) {
      projectKey = undefined;
    }

    // Obtener cloudId del usuario
    const cloudId = await this.getCloudId(accessToken);

    // Con rango de fechas: dividimos por día porque /search/jql no soporta paginación (máx ~50 por request)
    let issues: JiraIssue[];
    if (from && to) {
      issues = await this.getIssuesWithDateRangeSplit(baseJql, from, to, projectKey, accessToken, cloudId, username);
    } else {
      // Si no hay fechas, hacer búsqueda normal (solo primeros 50)
      // Pasamos username para filtrar directamente en el JQL
      const jql = this.buildJql(baseJql, from, to, projectKey, true, username);
      issues = await this.getIssues(jql, accessToken, cloudId);
    }

    // Obtener worklogs: intentar usar los que vienen en el issue primero
    // Solo hacer llamada adicional si hay más worklogs que los que ya trajo (total > worklogs.length)
    const CONCURRENCY_LIMIT = 10;
    const worklogsByIssue: Map<string, JiraWorklog[]> = new Map();

    // Primero, extraer worklogs que ya vienen en los issues
    const issuesNeedingFullWorklogs: JiraIssue[] = [];
    for (const issue of issues) {
      const issueWorklog = issue.fields?.worklog;
      if (issueWorklog && issueWorklog.worklogs) {
        // Si total es igual a la cantidad de worklogs que trajo, ya tenemos todos
        if (issueWorklog.total <= issueWorklog.worklogs.length) {
          worklogsByIssue.set(issue.key, issueWorklog.worklogs);
        } else {
          // Hay más worklogs, necesitamos obtenerlos todos con paginación
          issuesNeedingFullWorklogs.push(issue);
        }
      } else {
        // No vino worklog en el issue, necesitamos obtenerlo
        issuesNeedingFullWorklogs.push(issue);
      }
    }

    // Obtener worklogs completos solo para los issues que lo necesitan
    for (let i = 0; i < issuesNeedingFullWorklogs.length; i += CONCURRENCY_LIMIT) {
      const batch = issuesNeedingFullWorklogs.slice(i, i + CONCURRENCY_LIMIT);
      const promises = batch.map(async (issue) => {
        const worklogs = await this.getWorklogs(issue.key, accessToken, cloudId);
        return { issueKey: issue.key, worklogs };
      });

      const results = await Promise.all(promises);
      for (const { issueKey, worklogs } of results) {
        worklogsByIssue.set(issueKey, worklogs);
      }
    }

    // Agrupar worklogs por usuario y por issue
    const worklogsByUser: Record<
      string,
      {
        seconds: number;
        issues: Map<string, { issue: JiraIssue; worklogs: JiraWorklog[] }>;
      }
    > = {};

    for (const issue of issues) {
      const worklogs = worklogsByIssue.get(issue.key) || [];

      for (const w of worklogs) {
        // Filtrar por fecha en que se trabajaron las horas (started)
        if (!this.isWorklogInDateRange(w, from, to)) {
          continue;
        }

        const authorEmail = w.author.emailAddress || w.author.displayName;
        if (!authorEmail) {
          continue;
        }

        if (username && w.author.accountId !== username) {
          continue;
        }

        const seconds = w.timeSpentSeconds;

        if (!worklogsByUser[authorEmail]) {
          worklogsByUser[authorEmail] = {
            seconds: 0,
            issues: new Map(),
          };
        }
        worklogsByUser[authorEmail].seconds += seconds;

        // Agregar worklog al issue específico
        if (!worklogsByUser[authorEmail].issues.has(issue.key)) {
          worklogsByUser[authorEmail].issues.set(issue.key, {
            issue,
            worklogs: [],
          });
        }
        worklogsByUser[authorEmail].issues.get(issue.key)!.worklogs.push(w);
      }
    }

    // Formatear respuesta según estructura solicitada
    const worklogs = Object.entries(worklogsByUser).map(
      ([user, data]: [
        string,
        {
          seconds: number;
          issues: Map<string, { issue: JiraIssue; worklogs: JiraWorklog[] }>;
        },
      ]) => ({
        user,
        hours: (data.seconds / 3600).toFixed(2),
        worklogs: Array.from(data.issues.values()).flatMap((item) => item.worklogs),
        issues: Array.from(data.issues.values()).map((item) => ({
          ...item.issue,
          fields: {
            summary: item.issue.fields?.summary || '',
            assignee: item.issue.fields?.assignee || null,
            worklog: item.worklogs,
          },
        })),
      }),
    );

    return { worklogs };
  }
}
