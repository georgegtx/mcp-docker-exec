import winston from 'winston';
import { Config } from '../config/Config.js';

export class Logger {
  private winston: winston.Logger;
  private static config?: Config;

  constructor(private component: string) {
    const config = Logger.config || Config.load();

    const format = config.observability.structuredLogs
      ? winston.format.json()
      : winston.format.combine(
          winston.format.timestamp(),
          winston.format.printf(({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
            return `${timestamp} [${level.toUpperCase()}] [${this.component}] ${message}${metaStr}`;
          })
        );

    this.winston = winston.createLogger({
      level: config.observability.logLevel,
      format,
      transports: [
        new winston.transports.Console({
          stderrLevels: ['error', 'warn'],
        }),
      ],
    });
  }

  static initialize(config: Config): void {
    Logger.config = config;
  }

  debug(message: string, meta?: any): void {
    this.winston.debug(message, { component: this.component, ...meta });
  }

  info(message: string, meta?: any): void {
    this.winston.info(message, { component: this.component, ...meta });
  }

  warn(message: string, meta?: any): void {
    this.winston.warn(message, { component: this.component, ...meta });
  }

  error(message: string, meta?: any): void {
    this.winston.error(message, { component: this.component, ...meta });
  }

  child(component: string): Logger {
    return new Logger(`${this.component}.${component}`);
  }
}
