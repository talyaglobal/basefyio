/**
 * Maps platform-agnostic region/datacenter values to Hetzner location codes.
 *
 * Region keys are the generic values stored on ProvisioningProject.region.
 * If datacenter is set and matches a known Hetzner location code, it takes
 * precedence (allows pinning to a specific Hetzner datacenter without a new region).
 */

// Hetzner location → approximate geographic label for error messages
const REGION_TO_LOCATION: Record<string, string> = {
  'eu-central': 'nbg1',   // Nuremberg, Germany
  'eu-west':    'hel1',   // Helsinki, Finland
  'eu-south':   'fsn1',   // Falkenstein, Germany
  'us-east':    'ash',    // Ashburn, VA
  'us-west':    'hil',    // Hillsboro, OR
  'ap-southeast': 'sin',  // Singapore
};

const KNOWN_LOCATION_CODES = new Set(Object.values(REGION_TO_LOCATION));

export class HetznerLocationMapper {
  /**
   * Resolve a Hetzner location code from region + optional datacenter.
   *
   * @throws if region is unknown and datacenter is not a valid Hetzner location code.
   */
  static resolve(region: string, datacenter: string | null): string {
    // Direct datacenter pin — used when caller explicitly targets a Hetzner location
    if (datacenter && KNOWN_LOCATION_CODES.has(datacenter)) {
      return datacenter;
    }

    const location = REGION_TO_LOCATION[region];
    if (!location) {
      const supported = Object.keys(REGION_TO_LOCATION).join(', ');
      throw new Error(
        `No Hetzner location mapping for region '${region}'. ` +
        `Supported regions: ${supported}. ` +
        `Alternatively set datacenter to a Hetzner location code (${[...KNOWN_LOCATION_CODES].join(', ')}).`,
      );
    }
    return location;
  }

  /** Returns all supported region keys. Used for validation/documentation. */
  static supportedRegions(): string[] {
    return Object.keys(REGION_TO_LOCATION);
  }

  /** Returns all known Hetzner location codes. Used for datacenter pin validation. */
  static knownLocationCodes(): string[] {
    return [...KNOWN_LOCATION_CODES];
  }
}
