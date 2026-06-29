-- Add two nine-grid (九宮格) fields to ig_profiles:
--   identity_grid  : 8 things the creator's identity most often contacts
--   audience_grid  : 8 pains/problems the audience cares about
-- Stored as jsonb arrays of strings (length 8).
alter table public.ig_profiles
  add column if not exists identity_grid jsonb default '[]'::jsonb,
  add column if not exists audience_grid jsonb default '[]'::jsonb;
