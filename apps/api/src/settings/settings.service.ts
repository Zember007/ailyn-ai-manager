import { Injectable } from "@nestjs/common";
import type { BusinessRuleSettings } from "@ailyn/business-rules";
import { defaultBusinessRuleSettings } from "@ailyn/business-rules";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../database/prisma.service.js";

export interface Stage1Settings {
  companyName: string;
  assistantName: string;
  phone: string;
  whatsAppPhone: string;
  address: string;
  twoGisUrl: string;
  googleMapsUrl: string;
  timezone: string;
  schedule: string;
  latestArrivalTime: string;
  withoutStoragePercent: number;
  parkingPercent: number;
  withoutStorageLimitBishkekChuy: number;
  withoutStorageLimitOtherRegion: number;
  parkingLimit: number;
  minimumLoan: number;
  parkingInterestRate: { value?: number; blocked: boolean };
  parkingDailyFee: { value?: number; blocked: boolean };
  otherRegionMinVehicleValue: number;
}

export interface SettingDescriptor {
  key: keyof Stage1Settings;
  label: string;
  value: Stage1Settings[keyof Stage1Settings];
  type: "text" | "number" | "blocked";
  editable: boolean;
  blocked: boolean;
  reason?: string;
}

export interface SettingsResponse {
  values: Stage1Settings;
  fields: SettingDescriptor[];
}

const defaultSettings: Stage1Settings = {
  companyName: "Ailyn",
  assistantName: "Айлин",
  phone: "",
  whatsAppPhone: "",
  address: "Адрес офиса нужно подтвердить в настройках",
  twoGisUrl: "",
  googleMapsUrl: "",
  timezone: "Asia/Bishkek",
  schedule: "Понедельник-пятница",
  latestArrivalTime: "18:00",
  withoutStoragePercent: 0.4,
  parkingPercent: 0.5,
  withoutStorageLimitBishkekChuy: 600_000,
  withoutStorageLimitOtherRegion: 200_000,
  parkingLimit: 2_000_000,
  minimumLoan: 50_000,
  parkingInterestRate: { blocked: true },
  parkingDailyFee: { blocked: true },
  otherRegionMinVehicleValue: 1_000_000
};

const blockedReasons: Partial<Record<keyof Stage1Settings, string>> = {
  parkingInterestRate: "Ставка по стоянке помечена BLOCKED до письменного подтверждения.",
  parkingDailyFee: "Ежедневная плата по стоянке помечена BLOCKED до письменного подтверждения."
};

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<SettingsResponse> {
    const values = await this.getValues();
    return {
      values,
      fields: (Object.keys(defaultSettings) as (keyof Stage1Settings)[]).map((key) => ({
        key,
        label: settingLabel(key),
        value: values[key],
        type: blockedReasons[key] ? "blocked" : typeof values[key] === "number" ? "number" : "text",
        editable: !blockedReasons[key],
        blocked: Boolean(blockedReasons[key]),
        reason: blockedReasons[key]
      }))
    };
  }

  async getValues(): Promise<Stage1Settings> {
    const rows = await this.prisma.setting.findMany();
    const values: Stage1Settings = { ...defaultSettings };
    for (const row of rows) {
      (values as unknown as Record<string, unknown>)[row.key] = row.value;
    }
    return values;
  }

  async getBusinessRuleSettings(): Promise<BusinessRuleSettings> {
    const values = await this.getValues();
    return {
      ...defaultBusinessRuleSettings,
      withoutStoragePercent: values.withoutStoragePercent,
      parkingPercent: values.parkingPercent,
      withoutStorageLimitBishkekChuy: values.withoutStorageLimitBishkekChuy,
      withoutStorageLimitOtherRegion: values.withoutStorageLimitOtherRegion,
      parkingLimit: values.parkingLimit,
      minimumLoan: values.minimumLoan,
      otherRegionMinVehicleValue: values.otherRegionMinVehicleValue,
      latestArrivalTime: values.latestArrivalTime
    };
  }

  async update(patch: Partial<Stage1Settings>): Promise<SettingsResponse> {
    for (const [key, value] of Object.entries(patch) as [keyof Stage1Settings, Stage1Settings[keyof Stage1Settings]][]) {
      if (!(key in defaultSettings) || blockedReasons[key]) continue;
      await this.prisma.setting.upsert({
        where: { key },
        create: { key, value: toJson(value), blocked: false, updatedBy: "admin" },
        update: { value: toJson(value), blocked: false, updatedBy: "admin" }
      });
    }
    return this.get();
  }
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function settingLabel(key: keyof Stage1Settings): string {
  const labels: Record<keyof Stage1Settings, string> = {
    companyName: "Company name",
    assistantName: "Assistant name",
    phone: "Phone",
    whatsAppPhone: "WhatsApp phone",
    address: "Office address",
    twoGisUrl: "2GIS URL",
    googleMapsUrl: "Google Maps URL",
    timezone: "Timezone",
    schedule: "Schedule",
    latestArrivalTime: "Latest arrival time",
    withoutStoragePercent: "Without-storage percent",
    parkingPercent: "Parking percent",
    withoutStorageLimitBishkekChuy: "Bishkek/Chuy without-storage limit",
    withoutStorageLimitOtherRegion: "Other-region without-storage limit",
    parkingLimit: "Parking limit",
    minimumLoan: "Minimum loan",
    parkingInterestRate: "Parking interest rate",
    parkingDailyFee: "Parking daily fee",
    otherRegionMinVehicleValue: "Other-region minimum vehicle value"
  };
  return labels[key];
}
