import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { MasterOrderService } from './master-order.service';
import { Module } from '@nestjs/common';
import { BrokersModule } from '../brokers/brokers.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { ClientRegistryService } from './client-registry.service';
import { CopyEngineService } from './copy-engine.service';
import { CopyReconcilerService } from './copy-reconciler.service';
import { ClientAssignService } from './client-assign.service';
import { ClientSummaryService } from './client-summary.service';
import { PositionResizeService } from './position-resize.service';
import { FollowerController } from './follower.controller';
import { MasterPollerService } from './master-poller.service';
import { OrderMirrorService } from './order-mirror.service';
import { SignalService } from './signal.service';
import { MasterController } from './master.controller';
import { RiskService } from './risk.service';
import { TradingService } from './trading.service';

@Module({
  imports: [BrokersModule, MarketDataModule],
  controllers: [MasterController, FollowerController, WebhookController],
  providers: [WebhookService, MasterOrderService, SignalService, ClientAssignService, ClientSummaryService, PositionResizeService, TradingService, ClientRegistryService, CopyEngineService, CopyReconcilerService, OrderMirrorService, MasterPollerService, RiskService],
  exports: [MasterOrderService, SignalService, ClientAssignService, ClientSummaryService, CopyEngineService, CopyReconcilerService, RiskService, ClientRegistryService],
})
export class TradingModule {}
