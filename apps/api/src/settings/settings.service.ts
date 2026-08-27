import { Injectable } from "@nestjs/common";

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

@Injectable()
export class SettingsService {
  private settings: Stage1Settings = {
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

  get(): Stage1Settings {
    return this.settings;
  }

  update(patch: Partial<Stage1Settings>): Stage1Settings {
    this.settings = { ...this.settings, ...patch };
    return this.settings;
  }
}
