create table if not exists access_identities (
  access_sub text primary key,
  user_id text not null,
  created_at text not null default current_timestamp,
  revoked_at text
);

create index if not exists access_identities_user_id_idx
  on access_identities (user_id);
