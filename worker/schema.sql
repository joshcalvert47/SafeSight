-- SafeSight worker schema (Cloudflare D1 / SQLite).
-- One JSON document per row: the worker keeps the same object shapes the KV
-- build used, so `data` holds the whole record and the PK column is indexed.
--
-- This database now holds ONLY the legacy Chrome/Firefox extension path
-- (accounts/invites) — unchanged. Parenting data (families, children,
-- devices, pairing codes, unlock requests) lives in Firestore, governed by
-- firestore.rules at the repo root.

CREATE TABLE IF NOT EXISTS clients (
  id    TEXT PRIMARY KEY,
  data  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  email TEXT PRIMARY KEY,
  data  TEXT NOT NULL
);

-- Invite codes: one code creates one account (which starts as status
-- "pending" in the account document until the admin approves it).
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

-- Cleanup: these moved to Firestore (see firestore.rules). Drop them only
-- after the parent console and apps have been verified on Firestore.
-- DROP TABLE IF EXISTS users;
-- DROP TABLE IF EXISTS families;
-- DROP TABLE IF EXISTS children;
-- DROP TABLE IF EXISTS devices;
-- DROP TABLE IF EXISTS pairing_codes;
-- DROP TABLE IF EXISTS unlock_requests;
