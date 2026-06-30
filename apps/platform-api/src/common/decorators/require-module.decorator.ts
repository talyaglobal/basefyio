import { SetMetadata } from '@nestjs/common';

export const MODULE_KEY = 'required_module';

/** Mark a controller or handler as requiring a named project module to be enabled. */
export const RequireModule = (module: string) => SetMetadata(MODULE_KEY, module);
