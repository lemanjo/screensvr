let csrf = "";
export const setCSRF = (value: string) => {
  csrf = value;
};
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      "X-CSRF-Token": csrf,
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(data.error ?? "Request failed.", response.status);
  return data as T;
}
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";
