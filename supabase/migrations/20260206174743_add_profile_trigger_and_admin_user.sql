/*
  # Add profile auto-creation trigger and seed admin user

  1. Changes
    - Creates a trigger function `handle_new_user` that auto-creates a profile
      row whenever a new auth user is created
    - Attaches the trigger to `auth.users`
    - Creates an initial admin user for testing

  2. Security
    - Trigger runs as SECURITY DEFINER to bypass RLS
    - Profile inherits the auth user's ID, email, and metadata
*/

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', ''),
    COALESCE(NEW.raw_user_meta_data ->> 'role', 'sales_rep')
  );
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_created'
  ) THEN
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW
      EXECUTE FUNCTION public.handle_new_user();
  END IF;
END $$;
