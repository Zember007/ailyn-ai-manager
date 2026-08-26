import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { loadAppConfig } from "@ailyn/config";

async function bootstrap(): Promise<void> {
  const config = loadAppConfig();
  const app = await NestFactory.create(AppModule, { cors: true });
  app.setGlobalPrefix("api");
  await app.listen(config.apiPort, "0.0.0.0");
}

void bootstrap();
