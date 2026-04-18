import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator.js';
import { UserRole } from '../generated/prisma/client.js';
import { HolidaysService } from './holidays.service.js';
import { CreateHolidayDto } from './dto/create-holiday.dto.js';
import { UpdateHolidayDto } from './dto/update-holiday.dto.js';
import { BulkHolidaysDto } from './dto/bulk-holidays.dto.js';
import { ListHolidaysQueryDto } from './dto/list-holidays-query.dto.js';
import { ImportHolidaysQueryDto } from './dto/import-holidays-query.dto.js';

@ApiTags('holidays')
@ApiBearerAuth()
@Controller('holidays')
export class HolidaysController {
  constructor(private readonly svc: HolidaysService) {}

  @Get()
  findAll(@Query() query: ListHolidaysQueryDto) {
    return this.svc.findAll(query);
  }

  @Post()
  @Roles([UserRole.OWNER, UserRole.ADMIN])
  create(@Body() dto: CreateHolidayDto) {
    return this.svc.create(dto);
  }

  @Post('bulk')
  @Roles([UserRole.OWNER, UserRole.ADMIN])
  @ApiOperation({
    summary: 'Bulk create holidays',
    description: 'Up to 500 items. Duplicate dates are silently skipped.',
  })
  bulkCreate(@Body() dto: BulkHolidaysDto) {
    return this.svc.bulkCreate(dto);
  }

  @Post('import-official')
  @Roles([UserRole.OWNER, UserRole.ADMIN])
  @HttpCode(HttpStatus.NOT_IMPLEMENTED)
  @ApiOperation({
    summary: 'Import the official public holidays for a country (STUB)',
    description:
      'Returns HTTP 501. The endpoint contract is stable; the upstream integration with date.nager.at is tracked in docs/deferred-work.md D20.',
  })
  importOfficial(@Query() query: ImportHolidaysQueryDto) {
    return this.svc.importOfficial(query);
  }

  @Patch(':id')
  @Roles([UserRole.OWNER, UserRole.ADMIN])
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateHolidayDto,
  ) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @Roles([UserRole.OWNER, UserRole.ADMIN])
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(id);
  }
}
