import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Inject, Injectable, Logger, Module, NotFoundException, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import type { Enquiry, PrismaClient } from '@ctp/database';
import { Prisma } from '@ctp/database';
import type { EnquiryView, Paginated } from '@ctp/types';
import { clientInfo } from '../common/client-info';
import { AdminOnly, Public, Roles } from '../common/decorators/auth.decorators';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { PRISMA } from '../common/prisma/prisma.service';
import { EnquiryError, parseEnquiry } from './enquiry';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class EnquiriesQueryDto extends PaginationQueryDto {
  @IsIn(['CLIENT', 'PARTNER']) kind!: 'CLIENT' | 'PARTNER';
  @IsOptional() @IsIn(['NEW', 'CONTACTED', 'CLOSED']) status?: 'NEW' | 'CONTACTED' | 'CLOSED';
  @IsOptional() @IsString() @MaxLength(40) interest?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) q?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

export class UpdateEnquiryDto {
  @IsOptional() @IsEnum(['NEW', 'CONTACTED', 'CLOSED']) status?: 'NEW' | 'CONTACTED' | 'CLOSED';
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) note?: string;
}

const toView = (e: Enquiry): EnquiryView => ({
  id: e.id,
  kind: e.kind,
  status: e.status,
  name: e.name,
  email: e.email,
  phone: e.phone,
  company: e.company,
  city: e.city,
  interest: e.interest,
  details: (e.details as EnquiryView['details']) ?? null,
  message: e.message,
  note: e.note,
  page: e.page,
  ip: e.ip,
  createdAt: e.createdAt.toISOString(),
  updatedAt: e.updatedAt.toISOString(),
});

@Injectable()
export class EnquiriesService {
  private readonly logger = new Logger('Enquiries');

  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async create(body: unknown, req: Request): Promise<{ ok: true }> {
    let input;
    try {
      input = parseEnquiry(body);
    } catch (err) {
      if (err instanceof EnquiryError) throw new BadRequestException(err.message);
      throw err;
    }
    if (!input) return { ok: true }; // bot (honeypot filled): pretend it worked
    const { ip, userAgent } = clientInfo(req);
    await this.prisma.enquiry.create({
      data: { ...input, details: input.details ?? Prisma.JsonNull, ip, userAgent: userAgent?.slice(0, 300) ?? null },
    });
    this.logger.log(`New ${input.kind.toLowerCase()} enquiry (${input.interest}) from ${input.name}`);
    return { ok: true };
  }

  async list(q: EnquiriesQueryDto): Promise<Paginated<EnquiryView> & { counts: Record<'CLIENT' | 'PARTNER', number> }> {
    const where: Prisma.EnquiryWhereInput = {
      kind: q.kind,
      ...(q.status ? { status: q.status } : {}),
      ...(q.interest ? { interest: q.interest } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } } : {}),
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' } },
              { email: { contains: q.q, mode: 'insensitive' } },
              { phone: { contains: q.q } },
              { company: { contains: q.q, mode: 'insensitive' } },
              { city: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total, fresh] = await Promise.all([
      this.prisma.enquiry.findMany({ where, orderBy: { createdAt: 'desc' }, skip: q.skip, take: q.pageSize }),
      this.prisma.enquiry.count({ where }),
      this.prisma.enquiry.groupBy({ by: ['kind'], where: { status: 'NEW' }, _count: { _all: true } }),
    ]);
    const counts = { CLIENT: 0, PARTNER: 0 };
    for (const f of fresh) counts[f.kind] = f._count._all;
    return { items: items.map(toView), total, page: q.page, pageSize: q.pageSize, counts };
  }

  async update(id: string, dto: UpdateEnquiryDto): Promise<EnquiryView> {
    const found = await this.prisma.enquiry.findUnique({ where: { id }, select: { id: true } });
    if (!found) throw new NotFoundException('Enquiry not found');
    const e = await this.prisma.enquiry.update({
      where: { id },
      data: { ...(dto.status ? { status: dto.status } : {}), ...(dto.note !== undefined ? { note: dto.note || null } : {}) },
    });
    return toView(e);
  }
}

/**
 * Public form endpoint for the company website. The site posts JSON as text/plain (a "simple" cross-site request,
 * no preflight); the origin is allowed through PUBLIC_SITE_ORIGINS so the page can read the answer.
 */
@Controller('enquiries')
export class PublicEnquiriesController {
  constructor(private readonly enquiries: EnquiriesService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 10 * 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  @Post()
  create(@Body() body: unknown, @Req() req: Request) {
    return this.enquiries.create(body, req);
  }
}

/** Admin (full admin only): client enquiries and partner requests, kept apart by `kind`. */
@Roles('ADMIN')
@AdminOnly()
@Controller('admin/enquiries')
export class AdminEnquiriesController {
  constructor(private readonly enquiries: EnquiriesService) {}

  @Get()
  list(@Query() q: EnquiriesQueryDto) {
    return this.enquiries.list(q);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateEnquiryDto) {
    return this.enquiries.update(id, dto);
  }
}

@Module({
  controllers: [PublicEnquiriesController, AdminEnquiriesController],
  providers: [EnquiriesService],
})
export class EnquiriesModule {}
