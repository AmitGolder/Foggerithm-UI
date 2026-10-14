
import {
  Component,
  OnDestroy,
  OnInit,
  ChangeDetectorRef,
  inject
} from '@angular/core';

import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth';

interface FoggerSchedule {
  id: number;
  time: string;
  duration: number;
  enabled: boolean;
}

interface DeviceStatus {
  deviceId: string;
  deviceName: string;
  isConnected: boolean;
  isFoggerOn: boolean;
  connectionType: string;
  lastUpdated: string;
}

interface SavedTimer {
  endTime: number;
}

interface ActiveScheduleRun {
  scheduleId: number;
  endTime: number;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css'
})
export class Dashboard implements OnInit, OnDestroy {
  private readonly apiUrl = 'https://localhost:44361/api';

  private readonly http = inject(HttpClient);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);

  private readonly timerStorageKey = 'foggerithm-timer';
  private readonly activeRunStorageKey = 'foggerithm-active-run';
  private readonly lastRunStorageKey = 'foggerithm-last-runs';

  isFoggerOn = false;
  isApiReachable = false;
  isDeviceConnected = false;
  hasDevice = false;
  isPowerRequestRunning = false;
  apiError = '';

  timerMinutes = 5;
  remainingSeconds = 0;
  timerRunning = false;

  schedules: FoggerSchedule[] = [];
  newScheduleTime = '07:00';
  newScheduleDuration = 10;

  activeSchedule: ActiveScheduleRun | null = null;
  lastExecutionMessage = 'No scheduled runs yet.';

  private timerEndTime: number | null = null;
  private timerInterval?: ReturnType<typeof setInterval>;
  private scheduleInterval?: ReturnType<typeof setInterval>;
  private statusInterval?: ReturnType<typeof setInterval>;

  private lastRunBySchedule: Record<string, string> = {};
  private lastTimerOrigin: 'manual' | 'schedule' | null = null;

  ngOnInit(): void {
    this.loadSchedules();
    this.loadLastRuns();
    this.restoreTimer();
    this.restoreActiveSchedule();

    this.refreshDeviceStatus();

    this.scheduleInterval = setInterval(() => {
      this.checkSchedules();
      this.checkActiveSchedule();
      this.cdr.detectChanges();
    }, 1000);

    this.statusInterval = setInterval(() => {
      if (this.hasDevice) {
        this.refreshDeviceStatus();
      }
    }, 5000);

    this.checkSchedules();
    this.checkActiveSchedule();
  }

  refreshDeviceStatus(): void {
    this.http.get<DeviceStatus>(`${this.apiUrl}/Device/status`).subscribe({
      next: status => {
        this.isApiReachable = true;
        this.hasDevice = true;
        this.isDeviceConnected = status.isConnected;
        this.isFoggerOn = status.isFoggerOn;
        this.apiError = '';
        this.cdr.detectChanges();
      },
      error: error => {
        this.hasDevice = false;
        this.isFoggerOn = false;
        this.isDeviceConnected = false;

        this.apiError = error.status === 401
          ? 'Your session has expired. Please sign in again.'
          : error.status === 404
            ? 'No device is assigned to this account.'
            : 'Cannot reach the API. Check that the backend is running.';

        if (error.status === 401) {
          this.logout();
          return;
        }

        // A 404 means the API responded, but this account has no device.
        this.isApiReachable = error.status === 404;

        // Prevent a schedule or timer from controlling an unassigned device.
        if (error.status === 404) {
          this.stopTimer();
          this.stopActiveSchedule();
        }

        console.error('Device status request failed:', error);
        this.cdr.detectChanges();
      }
    });
  }

  toggleFogger(): void {
    if (
      this.isPowerRequestRunning ||
      !this.isApiReachable ||
      !this.hasDevice
    ) {
      return;
    }

    this.isPowerRequestRunning = true;
    this.apiError = '';

    this.http.post<DeviceStatus>(`${this.apiUrl}/Device/power`, {
      isOn: !this.isFoggerOn
    }).subscribe({
      next: status => {
        this.isApiReachable = true;
        this.hasDevice = true;
        this.isDeviceConnected = status.isConnected;
        this.isFoggerOn = status.isFoggerOn;
        this.isPowerRequestRunning = false;

        if (!status.isFoggerOn) {
          this.stopTimer();
          this.stopActiveSchedule();
        }

        this.cdr.detectChanges();
      },
      error: error => {
        this.isPowerRequestRunning = false;
        this.handleApiError(error, 'Power command failed.');
      }
    });
  }

  startTimer(): void {
    if (
      !this.hasDevice ||
      !this.isApiReachable ||
      !Number.isFinite(this.timerMinutes) ||
      this.timerMinutes < 1 ||
      this.timerMinutes > 1440
    ) {
      return;
    }

    this.stopTimer();
    this.stopActiveSchedule();

    this.lastTimerOrigin = 'manual';
    this.timerEndTime =
      Date.now() + Math.floor(this.timerMinutes * 60_000);

    localStorage.setItem(
      this.timerStorageKey,
      JSON.stringify({ endTime: this.timerEndTime })
    );

    this.timerRunning = true;
    this.updateRemainingTime();
    this.runTimerTick();
    this.setPowerFromAutomation(true);
  }

  stopTimer(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }

    this.timerInterval = undefined;
    this.timerEndTime = null;
    this.timerRunning = false;
    this.remainingSeconds = 0;
    this.lastTimerOrigin = null;

    localStorage.removeItem(this.timerStorageKey);
    this.cdr.detectChanges();
  }

  private restoreTimer(): void {
    const saved = localStorage.getItem(this.timerStorageKey);
    if (!saved) return;

    try {
      const timer = JSON.parse(saved) as SavedTimer;

      if (
        !Number.isFinite(timer.endTime) ||
        timer.endTime <= Date.now()
      ) {
        localStorage.removeItem(this.timerStorageKey);
        return;
      }

      this.timerEndTime = timer.endTime;
      this.timerRunning = true;
      this.lastTimerOrigin = 'manual';
      this.updateRemainingTime();
      this.runTimerTick();
    } catch {
      localStorage.removeItem(this.timerStorageKey);
    }
  }

  private updateRemainingTime(): void {
    this.remainingSeconds = this.timerEndTime === null
      ? 0
      : Math.max(
        0,
        Math.ceil((this.timerEndTime - Date.now()) / 1000)
      );
  }

  private runTimerTick(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }

    this.timerInterval = setInterval(() => {
      this.updateRemainingTime();

      if (this.remainingSeconds <= 0) {
        const origin = this.lastTimerOrigin;
        this.stopTimer();

        if (origin === 'manual') {
          this.setPowerFromAutomation(false);
        }
      }

      this.cdr.detectChanges();
    }, 250);
  }

  get formattedTime(): string {
    const minutes = Math.floor(this.remainingSeconds / 60);
    const seconds = this.remainingSeconds % 60;

    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  addSchedule(): void {
    if (
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(this.newScheduleTime) ||
      !Number.isFinite(this.newScheduleDuration) ||
      this.newScheduleDuration < 1 ||
      this.newScheduleDuration > 1440
    ) {
      return;
    }

    const schedule = {
      time: this.newScheduleTime,
      duration: Math.floor(this.newScheduleDuration),
      enabled: true
    };

    this.http.post<FoggerSchedule>(
      `${this.apiUrl}/Schedules`,
      schedule
    ).subscribe({
      next: saved => {
        this.schedules = [...this.schedules, saved]
          .sort((a, b) => a.time.localeCompare(b.time));

        this.apiError = '';
        this.cdr.detectChanges();
      },
      error: error => {
        this.handleApiError(error, 'Could not save the schedule.');
      }
    });
  }

  toggleSchedule(id: number): void {
    const schedule = this.schedules.find(item => item.id === id);
    if (!schedule) return;

    const updated = {
      ...schedule,
      enabled: !schedule.enabled
    };

    this.http.put<void>(
      `${this.apiUrl}/Schedules/${id}`,
      updated
    ).subscribe({
      next: () => {
        this.schedules = this.schedules.map(item =>
          item.id === id ? updated : item
        );

        this.apiError = '';
        this.cdr.detectChanges();
      },
      error: error => {
        this.handleApiError(error, 'Could not update the schedule.');
      }
    });
  }

  deleteSchedule(id: number): void {
    this.http.delete<void>(
      `${this.apiUrl}/Schedules/${id}`
    ).subscribe({
      next: () => {
        this.schedules = this.schedules.filter(
          item => item.id !== id
        );

        this.apiError = '';
        this.cdr.detectChanges();
      },
      error: error => {
        this.handleApiError(error, 'Could not delete the schedule.');
      }
    });
  }

  private checkSchedules(): void {
    if (
      !this.hasDevice ||
      !this.isApiReachable ||
      this.activeSchedule ||
      this.timerRunning
    ) {
      return;
    }

    const now = new Date();

    const currentTime = [
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0')
    ].join(':');

    const today = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    ].join('-');

    const due = this.schedules.find(schedule =>
      schedule.enabled &&
      schedule.time === currentTime &&
      this.lastRunBySchedule[String(schedule.id)] !== today
    );

    if (!due) return;

    this.lastRunBySchedule[String(due.id)] = today;
    this.saveLastRuns();
    this.startScheduledRun(due);
  }

  private startScheduledRun(schedule: FoggerSchedule): void {
    if (!this.hasDevice || !this.isApiReachable) return;

    this.stopTimer();

    this.activeSchedule = {
      scheduleId: schedule.id,
      endTime: Date.now() + schedule.duration * 60_000
    };

    localStorage.setItem(
      this.activeRunStorageKey,
      JSON.stringify(this.activeSchedule)
    );

    this.lastExecutionMessage =
      `Schedule ${schedule.time} started for ${schedule.duration} minutes.`;

    this.setPowerFromAutomation(true);
    this.checkActiveSchedule();
    this.cdr.detectChanges();
  }

  private restoreActiveSchedule(): void {
    const saved = localStorage.getItem(this.activeRunStorageKey);
    if (!saved) return;

    try {
      const run = JSON.parse(saved) as ActiveScheduleRun;

      if (
        !Number.isFinite(run.endTime) ||
        run.endTime <= Date.now()
      ) {
        localStorage.removeItem(this.activeRunStorageKey);
        return;
      }

      this.activeSchedule = run;

      const schedule = this.schedules.find(
        item => item.id === run.scheduleId
      );

      if (schedule) {
        this.lastExecutionMessage =
          `Schedule ${schedule.time} is running.`;
      }

      // The device check in setPowerFromAutomation prevents
      // commands if the account has no assigned device.
      this.setPowerFromAutomation(true);
      this.checkActiveSchedule();
    } catch {
      localStorage.removeItem(this.activeRunStorageKey);
    }
  }

  private checkActiveSchedule(): void {
    if (
      !this.activeSchedule ||
      Date.now() < this.activeSchedule.endTime
    ) {
      return;
    }

    this.stopActiveSchedule();
    this.setPowerFromAutomation(false);
    this.lastExecutionMessage = 'Scheduled run completed.';
    this.cdr.detectChanges();
  }

  private stopActiveSchedule(): void {
    this.activeSchedule = null;
    localStorage.removeItem(this.activeRunStorageKey);
  }

  private setPowerFromAutomation(isOn: boolean): void {
    if (!this.hasDevice || !this.isApiReachable) {
      return;
    }

    this.http.post<DeviceStatus>(
      `${this.apiUrl}/Device/power`,
      { isOn }
    ).subscribe({
      next: status => {
        this.isApiReachable = true;
        this.hasDevice = true;
        this.isDeviceConnected = status.isConnected;
        this.isFoggerOn = status.isFoggerOn;
        this.apiError = '';
        this.cdr.detectChanges();
      },
      error: error => {
        this.handleApiError(
          error,
          'Automation could not send its command to the API.'
        );
      }
    });
  }

  private loadSchedules(): void {
    this.http.get<FoggerSchedule[]>(
      `${this.apiUrl}/Schedules`
    ).subscribe({
      next: schedules => {
        this.schedules = schedules;
        this.cdr.detectChanges();
      },
      error: error => {
        this.handleApiError(error, 'Could not load schedules.');
      }
    });
  }

  private loadLastRuns(): void {
    try {
      this.lastRunBySchedule = JSON.parse(
        localStorage.getItem(this.lastRunStorageKey) ?? '{}'
      );
    } catch {
      this.lastRunBySchedule = {};
    }
  }

  private saveLastRuns(): void {
    localStorage.setItem(
      this.lastRunStorageKey,
      JSON.stringify(this.lastRunBySchedule)
    );
  }

  private handleApiError(error: any, message: string): void {
    if (error.status === 401) {
      this.logout();
      return;
    }

    if (error.status === 404) {
      this.hasDevice = false;
      this.isFoggerOn = false;
      this.isDeviceConnected = false;
      this.isApiReachable = true;

      this.stopTimer();
      this.stopActiveSchedule();

      this.apiError = 'No device is assigned to this account.';
    } else {
      this.apiError = message;
    }

    console.error(message, error);
    this.cdr.detectChanges();
  }

  logout(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }

  ngOnDestroy(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }

    if (this.scheduleInterval) {
      clearInterval(this.scheduleInterval);
    }

    if (this.statusInterval) {
      clearInterval(this.statusInterval);
    }
  }
}
