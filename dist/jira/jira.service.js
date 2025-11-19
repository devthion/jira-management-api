"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JiraService = void 0;
const common_1 = require("@nestjs/common");
const axios_1 = require("@nestjs/axios");
const rxjs_1 = require("rxjs");
let JiraService = class JiraService {
    http;
    atlassianApiUrl = 'https://api.atlassian.com';
    constructor(http) {
        this.http = http;
    }
    async getCloudId(accessToken) {
        const url = `${this.atlassianApiUrl}/oauth/token/accessible-resources`;
        try {
            const response = await (0, rxjs_1.firstValueFrom)(this.http.get(url, {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: 'application/json',
                },
            }));
            const resources = response.data;
            if (!resources || resources.length === 0) {
                throw new common_1.UnauthorizedException('No accessible Jira resources found for this token');
            }
            const jiraResource = resources.find((r) => r.scopes?.includes('read:jira-work'));
            if (!jiraResource) {
                throw new common_1.UnauthorizedException('No Jira resource found with required scopes');
            }
            return jiraResource.id;
        }
        catch (error) {
            const httpError = error;
            if (httpError.response?.status === 401 ||
                httpError.response?.status === 403) {
                throw new common_1.UnauthorizedException('Invalid or expired access token');
            }
            console.error('[Jira Error][getCloudId]', httpError.response?.data || httpError.message);
            throw new Error(`Failed to get cloudId: ${httpError.response?.status} - ${JSON.stringify(httpError.response?.data || httpError.message)}`);
        }
    }
    getJiraBaseUrl(cloudId) {
        return `${this.atlassianApiUrl}/ex/jira/${cloudId}/rest/api/3`;
    }
    getAuthHeader(accessToken) {
        return {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
        };
    }
    async getIssues(jql, accessToken, cloudId) {
        const baseUrl = this.getJiraBaseUrl(cloudId);
        const url = `${baseUrl}/search/jql`;
        try {
            const response = await (0, rxjs_1.firstValueFrom)(this.http.post(url, {
                jql,
                fields: ['summary', 'assignee', 'worklog'],
            }, { headers: this.getAuthHeader(accessToken) }));
            return response.data.issues || [];
        }
        catch (error) {
            console.log('error', error);
            const httpError = error;
            if (httpError.response?.status === 401 ||
                httpError.response?.status === 403) {
                throw new common_1.UnauthorizedException('Invalid or expired access token');
            }
            console.error('[Jira Error][getIssues]', httpError.response?.data || httpError.message);
            throw new Error(`Jira API error (${httpError.response?.status}): ${JSON.stringify(httpError.response?.data || httpError.message)}`);
        }
    }
    async getWorklogs(issueKey, accessToken, cloudId) {
        const baseUrl = this.getJiraBaseUrl(cloudId);
        const allWorklogs = [];
        let startAt = 0;
        const maxResults = 1000;
        try {
            while (true) {
                const url = `${baseUrl}/issue/${issueKey}/worklog?startAt=${startAt}&maxResults=${maxResults}`;
                const response = await (0, rxjs_1.firstValueFrom)(this.http.get(url, {
                    headers: this.getAuthHeader(accessToken),
                }));
                const worklogs = response.data.worklogs || [];
                allWorklogs.push(...worklogs);
                if (allWorklogs.length >= response.data.total ||
                    worklogs.length < maxResults) {
                    break;
                }
                startAt += maxResults;
            }
            return allWorklogs;
        }
        catch (error) {
            const httpError = error;
            if (httpError.response?.status === 401 ||
                httpError.response?.status === 403) {
                throw new common_1.UnauthorizedException('Invalid or expired access token');
            }
            console.error('[Jira Error][getWorklogs]', httpError.response?.data || httpError.message);
            return [];
        }
    }
    buildJql(baseJql, from, to) {
        let jql = baseJql;
        if (from || to) {
            const dateFilters = [];
            if (from) {
                dateFilters.push(`updated >= "${from}"`);
            }
            if (to) {
                dateFilters.push(`updated <= "${to}"`);
            }
            if (dateFilters.length > 0) {
                jql = `${jql} AND ${dateFilters.join(' AND ')}`;
            }
        }
        else if (!baseJql) {
            jql = `${jql} AND updated >= -7d`;
        }
        jql = `${jql} ORDER BY created DESC`;
        return jql;
    }
    isWorklogInDateRange(worklog, from, to) {
        if (!from && !to)
            return true;
        const worklogDate = worklog.started;
        if (!worklogDate)
            return false;
        const date = new Date(worklogDate);
        const dateStr = date.toISOString().split('T')[0];
        if (from && dateStr < from)
            return false;
        if (to && dateStr > to)
            return false;
        return true;
    }
    async getHoursByUser(accessToken, options = {}) {
        const { jql: baseJql, from, to, username } = options;
        const cloudId = await this.getCloudId(accessToken);
        const jql = this.buildJql(baseJql, from, to);
        const issues = await this.getIssues(jql, accessToken, cloudId);
        const worklogsByUser = {};
        console.log('issues', issues);
        for (const issue of issues) {
            const worklogs = await this.getWorklogs(issue.key, accessToken, cloudId);
            for (const w of worklogs) {
                if (!this.isWorklogInDateRange(w, from, to)) {
                    continue;
                }
                const authorEmail = w.author.emailAddress || w.author.displayName;
                if (!authorEmail) {
                    continue;
                }
                if (username &&
                    authorEmail !== username &&
                    w.author.displayName !== username) {
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
                if (!worklogsByUser[authorEmail].issues.has(issue.key)) {
                    worklogsByUser[authorEmail].issues.set(issue.key, {
                        issue,
                        worklogs: [],
                    });
                }
                worklogsByUser[authorEmail].issues.get(issue.key).worklogs.push(w);
            }
        }
        console.log('worklogsByUser', worklogsByUser);
        const worklogs = Object.entries(worklogsByUser).map(([user, data]) => ({
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
        }));
        return { worklogs };
    }
};
exports.JiraService = JiraService;
exports.JiraService = JiraService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [axios_1.HttpService])
], JiraService);
//# sourceMappingURL=jira.service.js.map