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
  guarantorMinimumAge: number;
  guarantorResidencePolicy: "SPEC_CONFLICT_C1" | "BISHKEK_CHUY" | "OUTSIDE_BISHKEK_CHUY";
  guarantorPersonalPresenceRequired: boolean;
  guarantorIdentityDocumentRequired: boolean;
  reminderScheduleHours: number[];
  reminderMaxCount: number;
  officeDogPolicy: string;
  currencyExchangeWalkingMinutes: string;
  queuePolicy: string;
  ownerAttendanceRequired: boolean;
  notarySchedule: string;
  notaryConsentApproximateCostSom: number;
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
  companyName: "Автоломбард «Молодой»",
  assistantName: "Айлин",
  phone: "+996 502 108 108",
  whatsAppPhone: "+996 776 108 108",
  address: "Б. Молодой Гвардии, 22, Бишкек",
  twoGisUrl: "https://go.2gis.com/Y34m4",
  googleMapsUrl: "https://maps.app.goo.gl/9xiWLVvdyRgn3Sx4A",
  timezone: "Asia/Bishkek",
  schedule: "ПН–ПТ 11:00–19:00",
  latestArrivalTime: "18:00",
  withoutStoragePercent: 0.4,
  parkingPercent: 0.5,
  withoutStorageLimitBishkekChuy: 600_000,
  withoutStorageLimitOtherRegion: 200_000,
  parkingLimit: 2_000_000,
  minimumLoan: 50_000,
  parkingInterestRate: { value: 2.4, blocked: false },
  parkingDailyFee: { value: 130, blocked: false },
  otherRegionMinVehicleValue: 1_000_000,
  guarantorMinimumAge: 25,
  guarantorResidencePolicy: "SPEC_CONFLICT_C1",
  guarantorPersonalPresenceRequired: true,
  guarantorIdentityDocumentRequired: true,
  reminderScheduleHours: [1, 24],
  reminderMaxCount: 2,
  officeDogPolicy: "Можно, если это не создаёт неудобств другим посетителям.",
  currencyExchangeWalkingMinutes: "примерно 5–10 минут пешком",
  queuePolicy: "Как правило, очереди нет, но точную ситуацию заранее гарантировать нельзя; лучше согласовать время визита.",
  ownerAttendanceRequired: true,
  notarySchedule: "ПН–ПТ 11:00–18:00",
  notaryConsentApproximateCostSom: 1500
};

const blockedReasons: Partial<Record<keyof Stage1Settings, string>> = {
  guarantorResidencePolicy: "SPEC_CONFLICT_C1: место прописки поручителя противоречит в исходном ТЗ.",
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
      latestArrivalTime: values.latestArrivalTime,
      guarantorMinimumAge: values.guarantorMinimumAge,
      guarantorResidencePolicy: values.guarantorResidencePolicy,
      guarantorPersonalPresenceRequired: values.guarantorPersonalPresenceRequired,
      guarantorIdentityDocumentRequired: values.guarantorIdentityDocumentRequired
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
    companyName: "Название компании",
    assistantName: "Имя ассистента",
    phone: "Основной телефон",
    whatsAppPhone: "Телефон WhatsApp",
    address: "Адрес офиса",
    twoGisUrl: "Ссылка 2GIS",
    googleMapsUrl: "Ссылка Google Maps",
    timezone: "Часовой пояс",
    schedule: "График работы",
    latestArrivalTime: "Крайнее время приезда",
    withoutStoragePercent: "Процент без изъятия",
    parkingPercent: "Процент по стоянке",
    withoutStorageLimitBishkekChuy: "Лимит без изъятия для Бишкек/Чуй",
    withoutStorageLimitOtherRegion: "Лимит без изъятия для других регионов",
    parkingLimit: "Максимальный лимит по стоянке",
    minimumLoan: "Минимальная сумма займа",
    parkingInterestRate: "Ставка по стоянке",
    parkingDailyFee: "Суточная плата за стоянку",
    otherRegionMinVehicleValue: "Минимальная стоимость авто для другого региона"
    ,guarantorMinimumAge: "Минимальный возраст поручителя"
    ,guarantorResidencePolicy: "Прописка поручителя"
    ,guarantorPersonalPresenceRequired: "Личное присутствие поручителя"
    ,guarantorIdentityDocumentRequired: "ID/паспорт поручителя"
    ,reminderScheduleHours: "Расписание напоминаний, часы"
    ,reminderMaxCount: "Максимум напоминаний"
    ,officeDogPolicy: "Посещение с собакой"
    ,currencyExchangeWalkingMinutes: "Расстояние до обмена валют"
    ,queuePolicy: "Политика очереди"
    ,ownerAttendanceRequired: "Личное присутствие собственника"
    ,notarySchedule: "График нотариуса"
    ,notaryConsentApproximateCostSom: "Стоимость нотариального согласия"
  };
  return labels[key];
}
