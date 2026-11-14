export class PhoneError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
    this.name = 'PhoneError';
  }
}
export function errorData(error: unknown) {
  if (error instanceof PhoneError)
    return { code: error.code, message: error.message, uncertain: error.uncertain };
  return {
    code: 'INTERNAL_ERROR',
    message: 'Unexpected local bridge error. Check the local installation.',
    uncertain: false,
  };
}
export function requireCapability(value: boolean, name: string): void {
  if (!value) throw new PhoneError('UNSUPPORTED', `This device does not advertise ${name}.`);
}
