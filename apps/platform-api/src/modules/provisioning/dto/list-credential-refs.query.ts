import { IsUUID } from 'class-validator';

export class ListCredentialRefsQuery {
  /**
   * Team ID — required. Returns only non-revoked credential refs for this team.
   */
  @IsUUID()
  teamId: string;
}
