-- Singleton-Constraint: nur id = 1 ist erlaubt (Spec C3-Rev3)
ALTER TABLE "PepperCanary"
  ADD CONSTRAINT "pepper_canary_singleton" CHECK (id = 1);