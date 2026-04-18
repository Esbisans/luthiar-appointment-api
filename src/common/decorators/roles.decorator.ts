import { Reflector } from '@nestjs/core';
import { UserRole } from '../../generated/prisma/client.js';

export const Roles = Reflector.createDecorator<UserRole[]>();
