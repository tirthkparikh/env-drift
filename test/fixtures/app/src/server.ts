import express from 'express';
const { STRIPE_SECRET_KEY, LOG_LEVEL = 'info' } = process.env;
const db = process.env.DATABASE_URL;
const port = process.env.PORT || 3000;
const sentry = process.env['SENTRY_DSN'];
const key = process.env[name];
if (process.env.NODE_ENV === 'production') console.log(process.env.FEATURE_FLAGS ?? '');
