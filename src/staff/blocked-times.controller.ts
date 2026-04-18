import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator.js';
import { UserRole } from '../generated/prisma/client.js';
import { BlockedTimesService } from './blocked-times.service.js';
import { CreateBlockedTimeDto } from './dto/create-blocked-time.dto.js';
import { ListBlockedTimesQueryDto } from './dto/list-blocked-times-query.dto.js';

@ApiTags('blocked-times')
@ApiBearerAuth()
@Controller('blocked-times')
export class BlockedTimesController {
  constructor(private readonly svc: BlockedTimesService) {}

  @Get()
  @ApiOperation({
    summary: 'List blocked time windows',
    description:
      'Use staffId=<id> for a specific staff, or omit to include business-wide blocks.',
  })
  findAll(@Query() query: ListBlockedTimesQueryDto) {
    return this.svc.findAll(query);
  }

  @Post()
  @Roles([UserRole.OWNER, UserRole.ADMIN])
  @ApiOperation({
    summary: 'Create a blocked time window',
    description:
      'Omit staffId for a business-wide block (e.g. office closure).',
  })
  create(@Body() dto: CreateBlockedTimeDto) {
    return this.svc.create(dto);
  }

  @Delete(':id')
  @Roles([UserRole.OWNER, UserRole.ADMIN])
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(id);
  }
}
