export const start: (width: number, height: number, port: number, token: string, allowLAN: boolean) => Promise<number>;
export const stop: () => Promise<number>;
export const status: () => string;
