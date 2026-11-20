import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { API_CONFIG, ApiConfig } from '../config/config.module';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}

/**
 * Outbound email. Uses SMTP when SMTP_HOST is configured.
 * Without SMTP: in APP_ENV=development the message is written to the API log so the
 * verification flow can be exercised locally; elsewhere the send is skipped with a warning.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  private readonly transporter: Transporter | null;

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {
    this.transporter = config.SMTP_HOST
      ? nodemailer.createTransport({
          host: config.SMTP_HOST,
          port: config.SMTP_PORT,
          secure: config.SMTP_PORT === 465,
          auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
        })
      : null;
  }

  async send(message: MailMessage): Promise<void> {
    if (this.transporter) {
      await this.transporter.sendMail({ from: this.config.MAIL_FROM, ...message });
      return;
    }
    if (this.config.APP_ENV === 'development') {
      this.logger.log(`[dev mail] to=${message.to} subject="${message.subject}"\n${message.text}`);
      return;
    }
    this.logger.warn(`SMTP not configured; email "${message.subject}" was not sent.`);
  }

  async sendEmailVerification(to: string, name: string, token: string): Promise<void> {
    const link = `${this.config.WEB_ORIGIN}/verify-email?token=${encodeURIComponent(token)}`;
    await this.send({
      to,
      subject: 'Verify your email address',
      text: `Hi ${name},\n\nConfirm your email address by opening this link (valid for 24 hours):\n${link}\n\nIf you did not create an account, ignore this email.`,
    });
  }
}

@Global()
@Module({ providers: [MailService], exports: [MailService] })
export class NotificationsModule {}
