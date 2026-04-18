import { PartialType } from '@nestjs/swagger';
import { CreateHolidayDto } from './create-holiday.dto.js';

export class UpdateHolidayDto extends PartialType(CreateHolidayDto) {}
