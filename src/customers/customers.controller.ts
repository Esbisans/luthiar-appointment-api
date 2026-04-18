import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Roles } from '../common/decorators/roles.decorator.js';
import { UserRole } from '../generated/prisma/client.js';
import { Audit } from '../audit/audit.decorator.js';
import { AuditInterceptor } from '../audit/audit.interceptor.js';
import { CustomersService } from './customers.service.js';
import { CreateCustomerDto } from './dto/create-customer.dto.js';
import { UpdateCustomerDto } from './dto/update-customer.dto.js';
import { FindOrCreateCustomerDto } from './dto/find-or-create-customer.dto.js';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto.js';

@ApiTags('customers')
@ApiBearerAuth()
@Controller('customers')
@UseInterceptors(AuditInterceptor)
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post()
  @Audit({ action: 'customer.created', targetType: 'customer', targetIdFrom: 'responseId' })
  @ApiOperation({ summary: 'Create a customer' })
  create(@Body() dto: CreateCustomerDto) {
    return this.customers.create(dto);
  }

  /**
   * NestJS uses `:` to denote path params, so Google AIP's `:findOrCreate`
   * syntax isn't directly portable. We use a hyphenated subpath — same
   * semantics, no routing ambiguity.
   */
  @Post('find-or-create')
  @ApiOperation({
    summary: 'Find an existing customer by phone or create one',
    description:
      'Returns 200 if the customer existed, 201 if created. Includes recent and upcoming appointments for the IA agent context.',
  })
  async findOrCreate(
    @Body() dto: FindOrCreateCustomerDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.customers.findOrCreate(dto);
    res.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result;
  }

  @Get()
  @ApiOperation({ summary: 'List customers' })
  findAll(@Query() query: ListCustomersQueryDto) {
    return this.customers.findAll(query);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('expand') expand?: string,
  ) {
    return this.customers.findOne(id, expand);
  }

  @Patch(':id')
  @Audit({ action: 'customer.updated', targetType: 'customer' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customers.update(id, dto);
  }

  @Delete(':id')
  @Roles([UserRole.OWNER, UserRole.ADMIN])
  @Audit({ action: 'customer.deleted', targetType: 'customer' })
  @ApiOperation({ summary: 'Soft-delete a customer' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.remove(id);
  }

  @Post(':id/purge')
  @Roles([UserRole.OWNER])
  @Audit({ action: 'customer.purged', targetType: 'customer' })
  @ApiOperation({
    summary: 'GDPR purge — anonymize a customer',
    description:
      'Replaces name/email/notes with nulls/placeholders while preserving FK references (appointments, payments). Owner only.',
  })
  purge(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.purge(id);
  }

  @Get(':id/appointments')
  @ApiOperation({ summary: 'List appointments for a customer (cursor paginated)' })
  listAppointments(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('cursor') cursor?: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
  ) {
    return this.customers.listAppointments(id, cursor, limit);
  }
}
