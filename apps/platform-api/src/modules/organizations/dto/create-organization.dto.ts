import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { OrganizationKind } from '@prisma/client';

const SELECTABLE_KINDS = Object.values(OrganizationKind).filter((k) => k !== 'PERSONAL');

export class CreateOrganizationDto {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;

  @IsOptional()
  @IsIn(SELECTABLE_KINDS)
  kind?: OrganizationKind;

  /** A public plan name; the free plan when omitted. Paid plans go through checkout afterwards. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  planName?: string;

  /** Where Stripe sends the browser after a paid plan's checkout; both needed for a checkoutUrl. */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  successUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  cancelUrl?: string;
}

export class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsIn(SELECTABLE_KINDS)
  kind?: OrganizationKind;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  websiteUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  logoUrl?: string | null;
}
