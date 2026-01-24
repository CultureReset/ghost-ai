import winston from 'winston';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Custom log format
const logFormat = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} [${level}]: ${stack || message}`;
});

// Create transports array - only console for Vercel/production
const transports = [
  new winston.transports.Console({
    format: combine(
      colorize(),
      logFormat
    )
  })
];

// Only add file transports in local development (not on Vercel)
if (process.env.NODE_ENV !== 'production') {
  try {
    if (!fs.existsSync('logs')) {
      fs.mkdirSync('logs');
    }

    transports.push(
      new winston.transports.File({
        filename: 'logs/error.log',
        level: 'error',
        maxsize: 5242880,
        maxFiles: 5
      }),
      new winston.transports.File({
        filename: 'logs/combined.log',
        maxsize: 5242880,
        maxFiles: 5
      })
    );
  } catch (error) {
    // Ignore file system errors on serverless platforms
    console.log('File logging disabled (serverless environment)');
  }
}

// Create logger instance
const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports
});

export default logger;
