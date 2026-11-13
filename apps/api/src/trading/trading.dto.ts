import { Transform, Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  IsBoolean,
} from 'class-validator';

const EXCHANGES = ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS', 'BCD'] as const;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class StrategyDto {
  @Transform(trim) @IsString() @Length(2, 100) name!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsIn(['LOW', 'MEDIUM', 'HIGH']) riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  @IsOptional() @IsArray() @ArrayUnique() @IsIn(EXCHANGES, { each: true }) allowedExchanges?: (typeof EXCHANGES)[number][];
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(40, { each: true }) allowedInstruments?: string[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) maxFollowers?: number;
  @Type(() => Number) @IsNumber() @Min(0) masterCapital!: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) maxOrderValue?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) maxQuantityPerOrder?: number;
}

export class StrategyStatusDto {
  @IsIn(['ACTIVE', 'PAUSED', 'ARCHIVED']) status!: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
}

export class MasterOrderDto {
  @IsString() strategyId!: string;
  @IsOptional() @IsString() brokerAccountId?: string;
  @IsIn(EXCHANGES) exchange!: (typeof EXCHANGES)[number];
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z0-9&_\-]{1,40}$/, { message: 'Invalid symbol' })
  symbol!: string;
  @IsIn(['BUY', 'SELL']) side!: 'BUY' | 'SELL';
  @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000) quantity!: number;
  @IsIn(['MARKET', 'LIMIT', 'SL', 'SL_M']) orderType!: 'MARKET' | 'LIMIT' | 'SL' | 'SL_M';
  @IsIn(['DELIVERY', 'INTRADAY', 'CARRY_FORWARD']) productType!: 'DELIVERY' | 'INTRADAY' | 'CARRY_FORWARD';
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) price?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) triggerPrice?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) lotSize?: number;
  /** Platform-managed target / stop loss for this signal (LTP based). */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) targetPrice?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) stopLossPrice?: number;
  /** Trailing stop loss step in points (needs a stop loss). Default: the strategy's automation setting. */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) trailPoints?: number;
}

export class SignalBookExitDto {
  @IsIn(EXCHANGES) exchange!: (typeof EXCHANGES)[number];
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z0-9&_\-]{1,40}$/, { message: 'Invalid symbol' })
  symbol!: string;
  @IsIn(['DELIVERY', 'INTRADAY', 'CARRY_FORWARD']) productType!: 'DELIVERY' | 'INTRADAY' | 'CARRY_FORWARD';
}

export class SignalTpSlDto {
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) targetPrice?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) stopLossPrice?: number | null;
}

/** Allocation + limits of one client in one strategy (admin assigns by user id, master by email). */
export class AssignStrategyDto {
  @IsOptional() @IsString() brokerAccountId?: string;
  @IsOptional() @IsEnum({ FIXED_QUANTITY: 'FIXED_QUANTITY', CAPITAL_PERCENTAGE: 'CAPITAL_PERCENTAGE', PROPORTIONAL: 'PROPORTIONAL' })
  allocationMode?: 'FIXED_QUANTITY' | 'CAPITAL_PERCENTAGE' | 'PROPORTIONAL';
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) allocationAmount?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.01) @Max(999.99, { message: "Lot multiplier can be at most 9.99×" }) allocationPercent?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) fixedQuantity?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) fixedLots?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) maxLots?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) maxQuantity?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) maxTradeValue?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) maxDailyLoss?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) maxTradesPerDay?: number;
  @IsOptional() @IsArray() @ArrayUnique() @IsIn(['EQ', 'FO'], { each: true }) allowedSegments?: ('EQ' | 'FO')[];
  @IsOptional() @IsBoolean() startCopy?: boolean;
}

export class AssignClientDto extends AssignStrategyDto {
  @Transform(trim) @IsString() @Length(3, 200) email!: string;
}

export class TradingModeDto {
  @IsIn(['PAPER', 'LIVE']) mode!: 'PAPER' | 'LIVE';
}

export class ClientHistoryQueryDto {
  /** today (default) | 7d | 30d | all */
  @IsOptional() @IsIn(['today', '7d', '30d', 'all']) range?: 'today' | '7d' | '30d' | 'all';
}

/** Admin correction of a signal in trade history (P&L is recomputed). */
export class EditSignalDto {
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) entryPrice?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) exitPrice?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000) quantity?: number;
}

export class ExitPositionDto {
  @IsString() accountId!: string;
  @IsIn(EXCHANGES) exchange!: (typeof EXCHANGES)[number];
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z0-9&_\-]{1,40}$/, { message: 'Invalid symbol' })
  symbol!: string;
  @IsIn(['DELIVERY', 'INTRADAY', 'CARRY_FORWARD']) productType!: 'DELIVERY' | 'INTRADAY' | 'CARRY_FORWARD';
}

export class FollowDto {
  /** Optional: without it the client's demat (or, with none, the internal paper account) is used. */
  @IsOptional() @IsString() brokerAccountId?: string;
  /** Resize trades already booked (still open) to the new allocation. Default true. */
  @IsOptional() @IsBoolean() applyToOpenTrades?: boolean;
  @IsEnum({ FIXED_QUANTITY: 'FIXED_QUANTITY', CAPITAL_PERCENTAGE: 'CAPITAL_PERCENTAGE', PROPORTIONAL: 'PROPORTIONAL' })
  allocationMode!: 'FIXED_QUANTITY' | 'CAPITAL_PERCENTAGE' | 'PROPORTIONAL';
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) allocationAmount?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.01) @Max(999.99, { message: "Lot multiplier can be at most 9.99×" }) allocationPercent?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) fixedQuantity?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) maxQuantity?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) maxTradeValue?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) fixedLots?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) maxLots?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) maxDailyLoss?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) maxTradesPerDay?: number;
  @IsOptional() @IsArray() @ArrayUnique() @IsIn(['EQ', 'FO'], { each: true }) allowedSegments?: ('EQ' | 'FO')[];
}
