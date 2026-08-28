import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from "@nestjs/common";
import { toPublicDatabaseErrorMessage } from "./prisma-errors.js";

interface HttpJsonResponse {
  status(code: number): HttpJsonResponse;
  json(payload: unknown): void;
}

@Catch()
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpJsonResponse>();
    const message = toPublicDatabaseErrorMessage(exception);

    if (message) {
      response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        error: "Service Unavailable",
        message
      });
      return;
    }

    throw exception;
  }
}
