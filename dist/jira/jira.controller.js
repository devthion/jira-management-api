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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JiraController = void 0;
const common_1 = require("@nestjs/common");
const jira_service_1 = require("./jira.service");
let JiraController = class JiraController {
    jiraService;
    constructor(jiraService) {
        this.jiraService = jiraService;
    }
    async getHoursByUser(authorization, body) {
        if (!authorization || !authorization.startsWith('Bearer ')) {
            throw new common_1.UnauthorizedException('Missing or invalid Authorization header. Expected: Bearer {token}');
        }
        const accessToken = authorization.substring(7);
        const { dateFrom, dateTo, username, jql } = body;
        return this.jiraService.getHoursByUser(accessToken, {
            jql,
            from: dateFrom,
            to: dateTo,
            username,
        });
    }
};
exports.JiraController = JiraController;
__decorate([
    (0, common_1.Post)('hours-by-user'),
    __param(0, (0, common_1.Headers)('authorization')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], JiraController.prototype, "getHoursByUser", null);
exports.JiraController = JiraController = __decorate([
    (0, common_1.Controller)('jira'),
    __metadata("design:paramtypes", [jira_service_1.JiraService])
], JiraController);
//# sourceMappingURL=jira.controller.js.map