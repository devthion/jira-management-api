import { HttpService } from '@nestjs/axios';
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
        emailAddress?: string;
        displayName?: string;
    };
    timeSpentSeconds: number;
    started?: string;
    created?: string;
}
export declare class JiraService {
    private readonly http;
    private readonly atlassianApiUrl;
    constructor(http: HttpService);
    private getCloudId;
    private getJiraBaseUrl;
    private getAuthHeader;
    getIssues(jql: string, accessToken: string, cloudId: string): Promise<JiraIssue[]>;
    getWorklogs(issueKey: string, accessToken: string, cloudId: string): Promise<JiraWorklog[]>;
    private buildJql;
    private isWorklogInDateRange;
    getHoursByUser(accessToken: string, options?: {
        jql?: string;
        from?: string;
        to?: string;
        username?: string;
    }): Promise<{
        worklogs: {
            user: string;
            hours: string;
            worklogs: JiraWorklog[];
            issues: {
                fields: {
                    summary: string;
                    assignee: {} | null;
                    worklog: JiraWorklog[];
                };
                id: string;
                key: string;
            }[];
        }[];
    }>;
}
export {};
