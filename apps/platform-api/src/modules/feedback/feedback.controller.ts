import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RootRoleGuard } from '../../common/guards/root-role.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { FeedbackService } from './feedback.service';
import { FeedbackAttachmentDto } from './feedback-attachment.dto';
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

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => FeedbackAttachmentDto)
  attachments?: FeedbackAttachmentDto[];
}

class UpdateFeedbackStatusDto {
  @IsEnum(FeedbackStatus)
  status: FeedbackStatus;
}

@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @UseGuards(JwtAuthGuard)
  @Post('attachments')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 21 * 1024 * 1024 } }),
  )
  async uploadAttachment(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file?.buffer) {
      throw new BadRequestException('File is required');
    }
    return this.feedbackService.uploadAttachment(
      user.sub,
      file.buffer,
      file.mimetype,
    );
  }

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
      attachments: dto.attachments,
    });
  }

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Get()
  async findAll() {
    return this.feedbackService.findAll();
  }

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Patch(':id')
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateFeedbackStatusDto,
  ) {
    return this.feedbackService.updateStatus(id, dto.status);
  }
}
