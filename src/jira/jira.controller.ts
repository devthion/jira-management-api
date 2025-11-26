import {
  Controller,
  Post,
  Body,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { JiraService } from './jira.service';

@Controller('jira')
export class JiraController {
  constructor(private readonly jiraService: JiraService) {}

  @Post('hours-by-user')
  async getHoursByUser(
    @Headers('authorization') authorization: string,
    @Body()
    body: {
      dateFrom?: string;
      dateTo?: string;
      username?: string;
      jql?: string;
      projectKey?: string;
    },
  ) {
    // Extraer el Bearer token del header
    if (!authorization || !authorization.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Missing or invalid Authorization header. Expected: Bearer {token}',
      );
    }

    const accessToken = authorization.substring(7); // Remover "Bearer "

    const { dateFrom, dateTo, username, jql, projectKey } = body;
    return this.jiraService.getHoursByUser(accessToken, {
      jql,
      from: dateFrom,
      to: dateTo,
      username,
      projectKey,
    });
  }
}
