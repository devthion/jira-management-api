import { Injectable, UnauthorizedException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

interface JiraIssue {
  id: string;
  key: string;
  fields?: {
    summary?: string;
    assignee?: unknown;
    worklog?: unknown;
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
   * Usa el endpoint POST /rest/api/3/search/jql
   * IMPORTANTE: Este endpoint NO soporta paginación - siempre devuelve los primeros ~50 issues
   * Por eso usamos la estrategia de dividir rangos de fechas para obtener todos los issues
   */
  async getIssues(jql: string, accessToken: string, cloudId: string): Promise<JiraIssue[]> {
    const baseUrl = this.getJiraBaseUrl(cloudId);
    const url = `${baseUrl}/search/jql`;

    console.log('jql', jql);

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

      const issues = response.data.issues || [];
      console.log(`[getIssues] Issues obtenidos: ${issues.length} (límite del endpoint: ~50)`);

      if (issues.length > 0) {
        const issueKeys = issues
          .slice(0, 5)
          .map((i) => i.key)
          .join(', ');
        console.log(`[getIssues] Primeros issue keys: ${issueKeys}${issues.length > 5 ? '...' : ''}`);
      }

      return issues;
    } catch (error) {
      console.log('error', error);
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

  /**
   * Método fallback sin paginación (usa POST /search/jql)
   */
  private async getIssuesFallback(jql: string, accessToken: string, cloudId: string): Promise<JiraIssue[]> {
    const baseUrl = this.getJiraBaseUrl(cloudId);
    const url = `${baseUrl}/search/jql`;

    console.log('[getIssuesFallback] Usando POST /search/jql (sin paginación)');

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

    const issues = response.data.issues || [];
    console.log(`[getIssuesFallback] Issues obtenidos: ${issues.length} (límite: ~50)`);
    return issues;
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
  ): string {
    let jql = baseJql?.trim() || '';
    const filters: string[] = [];

    console.log(`[buildJql] Input: baseJql="${baseJql}", projectKey="${projectKey}", from="${from}", to="${to}"`);

    // Si se proporciona projectKey y no está en el JQL base, agregarlo
    // Validar que no sea "undefined" como string
    if (projectKey && projectKey !== 'undefined' && !jql.toLowerCase().includes('project')) {
      filters.push(`project = ${projectKey}`);
      console.log(`[buildJql] Agregando filtro de proyecto: project = ${projectKey}`);
    } else if (projectKey && projectKey !== 'undefined' && jql.toLowerCase().includes('project')) {
      console.log(`[buildJql] El proyecto ya está en el JQL base, no se agrega duplicado`);
    } else if (!projectKey || projectKey === 'undefined') {
      console.warn(
        `[buildJql] ADVERTENCIA: No se proporcionó projectKey válido, el JQL puede traer issues de todos los proyectos`,
      );
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

      // IMPORTANTE: Limitar por fecha de creación del issue para evitar traer issues muy antiguos
      // Usamos 3 meses antes de la fecha "from" como límite (o 3 meses desde hoy si no hay "from")
      const today = new Date().toISOString().split('T')[0];
      const threeMonthsInDays = 90; // 3 meses
      const createdLimit = from
        ? this.subtractDays(from, threeMonthsInDays) // Issues creados máximo 3 meses antes del rango
        : this.subtractDays(today, threeMonthsInDays); // Últimos 3 meses si no hay from
      filters.push(`created >= "${createdLimit}"`);
    } else if (!jql) {
      // Si no hay fechas ni JQL personalizado, usar el default de últimos 30 días de worklog
      // y limitar a issues creados en los últimos 3 meses
      const today = new Date().toISOString().split('T')[0];
      const threeMonthsAgo = this.subtractDays(today, 90);
      filters.push('worklogDate >= -30d');
      filters.push(`created >= "${threeMonthsAgo}"`);
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

    console.log(`[buildJql] JQL final generado: ${jql}`);
    return jql;
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
   * Obtiene issues dividiendo el rango de fechas en sub-rangos para evitar el límite de 50 issues
   * Divide el rango en períodos de 7 días para asegurar que obtengamos todos los issues
   */
  private async getIssuesWithDateRangeSplit(
    baseJql: string | undefined,
    from: string,
    to: string,
    projectKey: string | undefined,
    accessToken: string,
    cloudId: string,
  ): Promise<JiraIssue[]> {
    const allIssues: JiraIssue[] = [];
    const uniqueIssueKeys = new Set<string>();

    // Dividir el rango en sub-rangos de 1 día para evitar perder issues
    // Si una semana tiene 50 issues, con 1 día por sub-rango deberíamos obtener todos
    const daysPerChunk = 1;
    const fromDate = new Date(from);
    const toDate = new Date(to);
    let currentDate = new Date(fromDate);

    console.log(`[getIssuesWithDateRangeSplit] Dividiendo rango ${from} a ${to} en sub-rangos de ${daysPerChunk} días`);

    while (currentDate <= toDate) {
      // Calcular el fin de este sub-rango (7 días después, o hasta 'to')
      const chunkEndDate = new Date(currentDate);
      chunkEndDate.setDate(chunkEndDate.getDate() + daysPerChunk);
      const chunkEnd = chunkEndDate > toDate ? to : chunkEndDate.toISOString().split('T')[0];
      const chunkStart = currentDate.toISOString().split('T')[0];

      console.log(`[getIssuesWithDateRangeSplit] Buscando sub-rango: ${chunkStart} a ${chunkEnd}`);

      // Construir JQL para este sub-rango sin expandir el rango de worklogDate
      // para evitar solapamientos entre sub-rangos
      const jql = this.buildJql(baseJql, chunkStart, chunkEnd, projectKey, false);

      // Obtener issues de este sub-rango
      const issues = await this.getIssues(jql, accessToken, cloudId);

      // Agregar solo issues únicos (por key) para evitar duplicados
      for (const issue of issues) {
        if (!uniqueIssueKeys.has(issue.key)) {
          uniqueIssueKeys.add(issue.key);
          allIssues.push(issue);
        }
      }

      console.log(
        `[getIssuesWithDateRangeSplit] Sub-rango ${chunkStart} a ${chunkEnd}: ${issues.length} issues nuevos, total acumulado: ${allIssues.length}`,
      );

      // Avanzar al siguiente sub-rango
      currentDate = new Date(chunkEndDate);
      currentDate.setDate(currentDate.getDate() + 1); // Empezar el día siguiente para evitar solapamientos
    }

    console.log(`[getIssuesWithDateRangeSplit] Total de issues únicos obtenidos: ${allIssues.length}`);
    return allIssues;
  }

  /**
   * Filtra un worklog por rango de fechas
   */
  private isWorklogInDateRange(worklog: JiraWorklog, from?: string, to?: string): boolean {
    if (!from && !to) return true;

    const worklogDate = worklog.started;
    if (!worklogDate) return false;

    const date = new Date(worklogDate);
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD

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
    const { jql: baseJql, from, to, username } = options;
    let { projectKey } = options;

    // Corregir projectKey si viene como string "undefined"
    if (projectKey === 'undefined' || projectKey === undefined) {
      projectKey = undefined;
    }

    console.log(
      `[getHoursByUser] Parámetros recibidos: baseJql="${baseJql}", projectKey="${projectKey}", from="${from}", to="${to}"`,
    );

    // Obtener cloudId del usuario
    const cloudId = await this.getCloudId(accessToken);

    // Obtener issues usando estrategia de búsqueda dividida si hay fechas
    // Divide el rango en sub-rangos para evitar el límite de 50 issues por request
    // Esto es necesario porque POST /search/jql NO soporta paginación
    let issues: JiraIssue[];
    if (from && to) {
      issues = await this.getIssuesWithDateRangeSplit(baseJql, from, to, projectKey, accessToken, cloudId);
    } else {
      // Si no hay fechas, hacer búsqueda normal (solo primeros 50)
      const jql = this.buildJql(baseJql, from, to, projectKey);
      issues = await this.getIssues(jql, accessToken, cloudId);
    }
    console.log(`[getHoursByUser] Total de issues obtenidos: ${issues.length}`);
    console.log(
      `[getHoursByUser] Issues keys: ${issues
        .map((i) => i.key)
        .slice(0, 20)
        .join(', ')}${issues.length > 20 ? '...' : ''}`,
    );

    // Diagnóstico: buscar un issue específico si está en los resultados
    if (issues.length > 0) {
      const firstIssue = issues[0];
      console.log(`[getHoursByUser] Primer issue de ejemplo: ${firstIssue.key} - ${firstIssue.fields?.summary}`);
    }

    // Obtener todos los worklogs en paralelo (mucho más rápido que secuencial)
    // Limitamos la concurrencia a 10 para no sobrecargar la API
    const CONCURRENCY_LIMIT = 10;
    const worklogsByIssue: Map<string, JiraWorklog[]> = new Map();

    for (let i = 0; i < issues.length; i += CONCURRENCY_LIMIT) {
      const batch = issues.slice(i, i + CONCURRENCY_LIMIT);
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
        // Filtrar worklogs por fecha
        if (!this.isWorklogInDateRange(w, from, to)) {
          continue;
        }

        // Usar emailAddress del autor (o displayName como fallback)
        const authorEmail = w.author.emailAddress || w.author.displayName;

        // Skip si no hay identificador de autor
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
