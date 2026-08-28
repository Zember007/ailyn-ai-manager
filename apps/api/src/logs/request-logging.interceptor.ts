import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable, catchError, tap, throwError } from "rxjs";
import { BackendLogsService } from "./backend-logs.service.js";

interface HttpRequestLike {
  method: string;
  originalUrl: string;
  body?: Record<string, unknown>;
}

interface HttpResponseLike {
  statusCode: number;
}

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  constructor(private readonly logs: BackendLogsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<HttpRequestLike>();
    const response = http.getResponse<HttpResponseLike>();
    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    const conversationId = readConversationId(request.body);

    void this.logs.debug("http.request", `${request.method} ${request.originalUrl}`, {
      requestId,
      method: request.method,
      path: request.originalUrl,
      conversationId
    });

    return next.handle().pipe(
      tap(() => {
        void this.logs.log("http.response", `${request.method} ${request.originalUrl} ${response.statusCode}`, {
          requestId,
          method: request.method,
          path: request.originalUrl,
          conversationId,
          metadata: { durationMs: Date.now() - startedAt, statusCode: response.statusCode }
        });
      }),
      catchError((error: unknown) => {
        void this.logs.error("http.error", `${request.method} ${request.originalUrl} failed`, {
          requestId,
          method: request.method,
          path: request.originalUrl,
          conversationId,
          metadata: {
            durationMs: Date.now() - startedAt,
            statusCode: response.statusCode || 500,
            errorName: error instanceof Error ? error.name : "UnknownError"
          },
          stack: error instanceof Error ? error.stack : undefined
        });
        return throwError(() => error);
      })
    );
  }
}

function readConversationId(body: Record<string, unknown> | undefined): string | undefined {
  const value = body?.conversationId;
  return typeof value === "string" && value.trim() ? value : undefined;
}
