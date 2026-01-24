import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

// Redis client for caching
const redis = new Redis(process.env.REDIS_URL, {
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  reconnectOnError(err) {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      return true; // Reconnect on readonly error
    }
    return false;
  }
});

redis.on('connect', () => {
  console.log('✅ Redis connected');
});

redis.on('error', (err) => {
  console.error('❌ Redis error:', err.message);
});

// Cache helper functions
export const cache = {
  /**
   * Get value from cache
   * @param {string} key
   * @returns {Promise<any>}
   */
  async get(key) {
    try {
      const value = await redis.get(key);
      return value ? JSON.parse(value) : null;
    } catch (err) {
      console.error('Cache get error:', err.message);
      return null;
    }
  },

  /**
   * Set value in cache with TTL
   * @param {string} key
   * @param {any} value
   * @param {number} ttl - Time to live in seconds (default: 5 minutes)
   */
  async set(key, value, ttl = 300) {
    try {
      await redis.setex(key, ttl, JSON.stringify(value));
      return true;
    } catch (err) {
      console.error('Cache set error:', err.message);
      return false;
    }
  },

  /**
   * Delete value from cache
   * @param {string} key
   */
  async del(key) {
    try {
      await redis.del(key);
      return true;
    } catch (err) {
      console.error('Cache delete error:', err.message);
      return false;
    }
  },

  /**
   * Delete all keys matching pattern
   * @param {string} pattern - e.g., 'business:*'
   */
  async delPattern(pattern) {
    try {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
      return true;
    } catch (err) {
      console.error('Cache delete pattern error:', err.message);
      return false;
    }
  }
};

export default redis;
