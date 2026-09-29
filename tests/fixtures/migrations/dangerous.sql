CREATE TABLE public.example_records (id bigint PRIMARY KEY);
ALTER TABLE public.example_records ADD COLUMN owner_id bigint NOT NULL;
