import { JiraService } from './jira.service';
export declare class JiraController {
    private readonly jiraService;
    constructor(jiraService: JiraService);
    getHoursByUser(authorization: string, body: {
        dateFrom?: string;
        dateTo?: string;
        username?: string;
        jql?: string;
        projectKey?: string;
    }): Promise<{
        worklogs: {
            user: string;
            hours: string;
            worklogs: import("./jira.service").JiraWorklog[];
            issues: {
                fields: {
                    summary: string;
                    assignee: {} | null;
                    worklog: import("./jira.service").JiraWorklog[];
                };
                id: string;
                key: string;
            }[];
        }[];
    }>;
}
