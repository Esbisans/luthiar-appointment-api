/**
 * Demo seed — poblado de un tenant realista para:
 *   1. Dogfooding (el primer tenant del desarrollo)
 *   2. El agente del dashboard Next.js (datos listos para probar listas,
 *      calendarios, búsqueda, filtros sin tener que crear todo a mano)
 *
 * Idempotente: si el business `demo-dogfood` ya existe, borra todo en
 * cascada antes de recrearlo. Corre contra `MIGRATION_DATABASE_URL`
 * (superuser — RLS no aplica) para evitar tener que manejar session vars.
 *
 * Uso:
 *   npm run seed               # crea/recrea el tenant demo
 *   npm run seed -- --clean    # solo borra (sin recrear)
 *
 * Credenciales del OWNER tras correr:
 *   email:    owner@demo.dev
 *   password: Password123!
 */

import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';
import 'dotenv/config';

const DEMO_SLUG = 'demo-dogfood';
const DEMO_OWNER_EMAIL = 'owner@demo.dev';
const DEMO_PASSWORD = 'Password123!';

// Argon2 cost params a nivel de test — rápido en seed pero reescribible
// al login real (argon2 reescribe si el hash actual es más débil).
const ARGON2_OPTS = {} as const;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cleanOnly = args.includes('--clean');

  // Usar MIGRATION_DATABASE_URL si está seteada (superuser para bypass RLS),
  // sino fallback a DATABASE_URL. El seed requiere superuser para insertar
  // sin colisiones de `app.current_business_id`.
  const url =
    process.env['MIGRATION_DATABASE_URL'] ??
    process.env['DATABASE_URL'] ??
    undefined;
  if (!url) {
    throw new Error(
      'Neither MIGRATION_DATABASE_URL nor DATABASE_URL is set. Copy ' +
        '.env.test.example to .env and configure the DB URLs first.',
    );
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });

  try {
    await cleanExisting(prisma);
    if (cleanOnly) {
      console.log('✓ Cleaned existing demo tenant (no recreate).');
      return;
    }
    await seedTenant(prisma);
    console.log(`
✓ Seed complete.
  Business slug: ${DEMO_SLUG}
  Owner email:   ${DEMO_OWNER_EMAIL}
  Password:      ${DEMO_PASSWORD}
`);
  } finally {
    await prisma.$disconnect();
  }
}

async function cleanExisting(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.business.findUnique({
    where: { slug: DEMO_SLUG },
    select: { id: true },
  });
  if (!existing) return;
  // onDelete: Cascade en el schema borra staff, services, customers,
  // appointments, payments, conversations, notifications, apiKeys, etc.
  // RefreshToken cae con el user.
  await prisma.business.delete({ where: { id: existing.id } });
  console.log('✓ Cleaned existing demo-dogfood tenant.');
}

async function seedTenant(prisma: PrismaClient): Promise<void> {
  const business = await prisma.business.create({
    data: {
      name: 'Salón Demo MX',
      slug: DEMO_SLUG,
      email: 'contacto@demo.dev',
      phone: '+525512340000',
      address: 'Av. Reforma 100',
      city: 'Ciudad de México',
      state: 'CDMX',
      country: 'MX',
      timezone: 'America/Mexico_City',
      plan: 'PRO',
      cancellationPolicy:
        'Cancelaciones hasta 24h antes. Después se cobra el 50% del servicio.',
      cancellationHours: 24,
      refundEnabled: true,
    },
  });

  const owner = await prisma.user.create({
    data: {
      businessId: business.id,
      email: DEMO_OWNER_EMAIL,
      password: await argon2.hash(DEMO_PASSWORD, ARGON2_OPTS),
      name: 'Esau Demo',
      role: 'OWNER',
      isActive: true,
    },
  });

  // Notification settings (el business necesita estos para poder recibir).
  await prisma.notificationSetting.create({
    data: {
      businessId: business.id,
      reminder24hEnabled: true,
      reminder1hEnabled: true,
      confirmationEnabled: true,
      cancellationEnabled: true,
      preferredChannel: 'WHATSAPP',
    },
  });

  await seedBusinessHours(prisma, business.id);
  await seedHolidays(prisma, business.id);
  const services = await seedServices(prisma, business.id);
  const staff = await seedStaff(prisma, business.id);
  await seedStaffServices(prisma, business.id, staff, services);
  await seedStaffAvailability(prisma, business.id, staff);
  const customers = await seedCustomers(prisma, business.id);
  await seedAppointments(prisma, business.id, staff, services, customers);

  console.log(
    `✓ Seeded: 1 business, 1 owner (${owner.email}), 7 business-hour rows, ` +
      `${services.length} services, ${staff.length} staff, ${customers.length} customers, ` +
      `and appointments across 4 weeks.`,
  );
}

async function seedBusinessHours(
  prisma: PrismaClient,
  businessId: string,
): Promise<void> {
  // Mon-Fri 9-18, Sat 10-14, Sun closed. 7 filas totales (el domingo queda
  // marcado isOpen=false para que el engine sepa que está explícitamente
  // cerrado — no assume "no row = closed").
  const days = [
    { dayOfWeek: 'MONDAY', startTime: '09:00', endTime: '18:00', isOpen: true },
    { dayOfWeek: 'TUESDAY', startTime: '09:00', endTime: '18:00', isOpen: true },
    { dayOfWeek: 'WEDNESDAY', startTime: '09:00', endTime: '18:00', isOpen: true },
    { dayOfWeek: 'THURSDAY', startTime: '09:00', endTime: '18:00', isOpen: true },
    { dayOfWeek: 'FRIDAY', startTime: '09:00', endTime: '18:00', isOpen: true },
    { dayOfWeek: 'SATURDAY', startTime: '10:00', endTime: '14:00', isOpen: true },
    { dayOfWeek: 'SUNDAY', startTime: '00:00', endTime: '00:00', isOpen: false },
  ] as const;
  await prisma.businessHour.createMany({
    data: days.map((d) => ({ businessId, ...d })),
  });
}

async function seedHolidays(
  prisma: PrismaClient,
  businessId: string,
): Promise<void> {
  // 2 holidays próximos (año actual). El frontend debería mostrar el
  // calendario con estos días grisados.
  const year = new Date().getFullYear();
  await prisma.holiday.createMany({
    data: [
      {
        businessId,
        date: new Date(Date.UTC(year, 8, 16)),  // 16 de septiembre
        name: 'Día de la Independencia',
        isRecurring: true,
      },
      {
        businessId,
        date: new Date(Date.UTC(year, 11, 12)), // 12 de diciembre
        name: 'Día de la Virgen de Guadalupe',
        isRecurring: true,
      },
    ],
  });
}

async function seedServices(
  prisma: PrismaClient,
  businessId: string,
): Promise<Array<{ id: string; duration: number; name: string }>> {
  const rows = [
    { name: 'Corte de cabello', description: 'Corte clásico con lavado.', duration: 45, price: 250, slotIntervalMin: 15 },
    { name: 'Tinte completo', description: 'Tinte con color a elegir.', duration: 90, price: 800, slotIntervalMin: 30 },
    { name: 'Manicura', description: 'Manicura básica con esmalte.', duration: 60, price: 350, slotIntervalMin: 15 },
    { name: 'Pedicura', description: 'Pedicura spa con exfoliación.', duration: 75, price: 450, slotIntervalMin: 15 },
    { name: 'Alisado', description: 'Alisado con keratina.', duration: 120, price: 1500, slotIntervalMin: 30 },
  ];
  const created = [];
  for (const r of rows) {
    const s = await prisma.service.create({
      data: { businessId, ...r, currency: 'MXN', bufferBefore: 5, bufferAfter: 5 },
      select: { id: true, duration: true, name: true },
    });
    created.push(s);
  }
  return created;
}

async function seedStaff(
  prisma: PrismaClient,
  businessId: string,
): Promise<Array<{ id: string; name: string }>> {
  const names = [
    { name: 'Ana García', email: 'ana@demo.dev', phone: '+525512340101' },
    { name: 'Carlos Hernández', email: 'carlos@demo.dev', phone: '+525512340102' },
    { name: 'María López', email: 'maria@demo.dev', phone: '+525512340103' },
    { name: 'José Rodríguez', email: 'jose@demo.dev', phone: '+525512340104' },
    { name: 'Laura Martínez', email: 'laura@demo.dev', phone: '+525512340105' },
  ];
  const created = [];
  for (const n of names) {
    const s = await prisma.staff.create({
      data: {
        businessId,
        name: n.name,
        email: n.email,
        phone: n.phone,
        bio: `Staff especializado en servicios del salón.`,
        isActive: true,
      },
      select: { id: true, name: true },
    });
    created.push(s);
  }
  return created;
}

async function seedStaffServices(
  prisma: PrismaClient,
  businessId: string,
  staff: Array<{ id: string }>,
  services: Array<{ id: string }>,
): Promise<void> {
  // Cada staff ofrece TODOS los servicios para simplificar el engine. Si
  // quieres staff especializados, restringe acá.
  const data = staff.flatMap((s) =>
    services.map((sv) => ({ staffId: s.id, serviceId: sv.id, businessId })),
  );
  await prisma.staffService.createMany({ data });
}

async function seedStaffAvailability(
  prisma: PrismaClient,
  businessId: string,
  staff: Array<{ id: string }>,
): Promise<void> {
  // Cada staff Mon-Fri 9-17 (una hora menos que business hours para dejar
  // margen en cierre). No incluir Sat-Sun aquí para que el engine cruce con
  // business hours y respete ambos.
  const weekdays = [
    'MONDAY',
    'TUESDAY',
    'WEDNESDAY',
    'THURSDAY',
    'FRIDAY',
  ] as const;
  const rows = staff.flatMap((s) =>
    weekdays.map((d) => ({
      staffId: s.id,
      businessId,
      dayOfWeek: d,
      startTime: '09:00',
      endTime: '17:00',
      isActive: true,
    })),
  );
  await prisma.staffAvailability.createMany({ data: rows });
}

async function seedCustomers(
  prisma: PrismaClient,
  businessId: string,
): Promise<Array<{ id: string }>> {
  const firstNames = ['Andrea', 'Brenda', 'Carolina', 'Daniela', 'Elena', 'Fernanda', 'Gabriela', 'Hilda', 'Irene', 'Julia'];
  const lastNames = ['Torres', 'Ramírez', 'Cruz', 'Sánchez', 'Gómez', 'Flores', 'Rivera', 'Díaz', 'Morales', 'Ortiz'];
  const created = [];
  for (let i = 0; i < 30; i++) {
    const first = firstNames[i % firstNames.length]!;
    const last = lastNames[Math.floor(i / firstNames.length) % lastNames.length]!;
    const c = await prisma.customer.create({
      data: {
        businessId,
        name: `${first} ${last}`,
        phone: `+52551234${String(1000 + i).padStart(4, '0')}`,
        email: i % 3 === 0 ? `${first.toLowerCase()}.${last.toLowerCase()}@demo.dev` : null,
        notes: i % 5 === 0 ? `Prefiere horario matutino.` : null,
      },
      select: { id: true },
    });
    created.push(c);
  }
  return created;
}

async function seedAppointments(
  prisma: PrismaClient,
  businessId: string,
  staff: Array<{ id: string; name: string }>,
  services: Array<{ id: string; duration: number }>,
  customers: Array<{ id: string }>,
): Promise<void> {
  // Distribución realista:
  //   - 10 COMPLETED en los últimos 14 días
  //   - 3 CANCELLED en los últimos 7 días
  //   - 2 NO_SHOW en los últimos 7 días
  //   - 15 CONFIRMED en los próximos 7 días
  //   - 10 PENDING en los próximos 14 días
  //
  // Anclado a las 10:00 del día para caer en business hours. Cada staff
  // toma slots consecutivos (sin overlap) para no activar el EXCLUDE
  // constraint.
  const now = new Date();
  const buckets = [
    { status: 'COMPLETED', daysOffset: -14, count: 10 },
    { status: 'CANCELLED', daysOffset: -5, count: 3 },
    { status: 'NO_SHOW', daysOffset: -3, count: 2 },
    { status: 'CONFIRMED', daysOffset: 1, count: 15 },
    { status: 'PENDING', daysOffset: 7, count: 10 },
  ] as const;

  let created = 0;
  for (const b of buckets) {
    for (let i = 0; i < b.count; i++) {
      const customer = customers[created % customers.length]!;
      const s = staff[created % staff.length]!;
      const svc = services[created % services.length]!;
      // Slots de 2h separados por staff — evita colisión del EXCLUDE constraint.
      const dayShift = b.daysOffset + Math.floor(i / staff.length);
      const hourSlot = 10 + ((i % staff.length) * 2);
      const start = new Date(now);
      start.setDate(start.getDate() + dayShift);
      start.setHours(hourSlot, 0, 0, 0);
      const end = new Date(start.getTime() + svc.duration * 60 * 1000);

      // Saltar fines de semana para simplificar — el engine rechazaría el
      // slot si el business está cerrado.
      const day = start.getDay();
      if (day === 0) continue; // domingo

      await prisma.appointment.create({
        data: {
          businessId,
          customerId: customer.id,
          staffId: s.id,
          serviceId: svc.id,
          status: b.status,
          startTime: start,
          endTime: end,
          channel: created % 2 === 0 ? 'VOICE' : 'WEB_CHAT',
          source: created % 2 === 0 ? 'voice' : 'dashboard',
          cancelledAt: b.status === 'CANCELLED' ? new Date(start.getTime() - 3600_000) : null,
          cancellationReason: b.status === 'CANCELLED' ? 'Cliente no disponible' : null,
        },
      });
      created++;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
