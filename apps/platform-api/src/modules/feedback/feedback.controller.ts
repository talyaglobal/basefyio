import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Delete,
  Put,
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

class UpdateFeedbackDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  description?: string;
}

class AddCommentDto {
  @IsString()
  @IsNotEmpty()
  comment: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => FeedbackAttachmentDto)
  attachments?: FeedbackAttachmentDto[];
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

  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll(@CurrentUser() user: JwtPayload) {
    return this.feedbackService.findAllForUser(user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async updateStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateFeedbackStatusDto,
  ) {
    return this.feedbackService.updateStatus(user.sub, id, dto.status);
  }

  @UseGuards(JwtAuthGuard)
  @Put(':id')
  async updateFeedback(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateFeedbackDto,
  ) {
    return this.feedbackService.updateFeedback(user.sub, id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async removeFeedback(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.feedbackService.removeFeedback(user.sub, id);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/comments')
  async listComments(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    return this.feedbackService.listComments(user.sub, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/comments')
  async addComment(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: AddCommentDto,
  ) {
    return this.feedbackService.addComment(user.sub, user.preferred_username, id, dto);
  }
}
