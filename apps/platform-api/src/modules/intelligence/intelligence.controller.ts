import { Body, Controller, Post, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { IntelligenceService } from './intelligence.service';
import { AskDto } from './dto/ask.dto';

@Controller('v1/intelligence')
@UseGuards(JwtOrApiKeyGuard)
export class IntelligenceController {
  constructor(private readonly service: IntelligenceService) {}

  @Post('ask')
  @HttpCode(HttpStatus.OK)
  ask(@Body() dto: AskDto, @CurrentUser() user: JwtPayload) {
    return this.service.ask(user.sub, dto.projectId, dto.question);
  }
}
