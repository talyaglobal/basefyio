import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { FeedbackService } from './feedback.service';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { FeedbackStatus, FeedbackType } from '@prisma/client';

class CreateFeedbackDto {
  @IsString()
  @IsNotEmpty()
  url: string;

  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsEnum(FeedbackType)
  @IsOptional()
  type?: FeedbackType;
}

class UpdateFeedbackStatusDto {
  @IsEnum(FeedbackStatus)
  status: FeedbackStatus;
}

@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateFeedbackDto,
  ) {
    return this.feedbackService.create({
      userId: user.sub,
      username: user.preferred_username,
      email: user.email,
      url: dto.url,
      title: dto.title,
      description: dto.description,
      type: dto.type,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll() {
    return this.feedbackService.findAll();
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateFeedbackStatusDto,
  ) {
    return this.feedbackService.updateStatus(id, dto.status);
  }
}
