import { IsBoolean } from 'class-validator';

export class UpdateTeamSecurityDto {
  /** When true every member must sign in with an authenticator; applied at each member's next sign-in. */
  @IsBoolean()
  requireMfa!: boolean;
}
