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
   * Usa el nuevo endpoint oficial de Atlassian:
   * POST /rest/api/3/search/jql
   * (El anterior /search fue eliminado, retorna 410)
   */
  async getIssues(jql: string, accessToken: string, cloudId: string): Promise<JiraIssue[]> {
    const baseUrl = this.getJiraBaseUrl(cloudId);
    const url = `${baseUrl}/search/jql`;
    //TODO las fechas de from y to estan mal por que con ellas se rompe la request
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
   * Construye el JQL con filtros de fecha si se proporcionan
   */
  private buildJql(baseJql?: string, from?: string, to?: string): string {
    let jql = baseJql?.trim() || '';

    // Si se proporcionan fechas, agregar filtros de fecha
    if (from || to) {
      const dateFilters: string[] = [];

      if (from) {
        dateFilters.push(`updated >= "${from}"`);
      }

      if (to) {
        dateFilters.push(`updated <= "${to}"`);
      }

      if (dateFilters.length > 0) {
        const dateFilterStr = dateFilters.join(' AND ');
        jql = jql ? `${jql} AND ${dateFilterStr}` : dateFilterStr;
      }
    } else if (!jql) {
      // Si no hay fechas ni JQL personalizado, usar el default de últimos 7 días
      jql = 'updated >= -7d';
    }

    // Agregar ORDER BY solo si hay contenido
    if (jql) {
      jql = `${jql} ORDER BY created DESC`;
    }

    return jql;
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
    } = {},
  ) {
    const { jql: baseJql, from, to, username } = options;

    // Obtener cloudId del usuario
    const cloudId = await this.getCloudId(accessToken);

    // Construir JQL
    const jql = this.buildJql(baseJql, from, to);

    // Obtener issues
    const issues = await this.getIssues(jql, accessToken, cloudId);

    // Agrupar worklogs por usuario y por issue
    const worklogsByUser: Record<
      string,
      {
        seconds: number;
        issues: Map<string, { issue: JiraIssue; worklogs: JiraWorklog[] }>;
      }
    > = {};
    for (const issue of issues) {
      const worklogs = await this.getWorklogs(issue.key, accessToken, cloudId);
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
