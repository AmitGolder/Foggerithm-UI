
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';

const API_URL = 'https://localhost:44361/api';

export interface AuthUser {
  id: string;
  fullName: string;
  email: string;
  roles: string[];
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
  user: AuthUser;
}

export interface RegisterRequest {
  fullName: string;
  email: string;
  password: string;
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private readonly http = inject(HttpClient);

  login(email: string, password: string): Observable<LoginResponse> {
    return this.http
      .post<LoginResponse>(`${API_URL}/Auth/login`, {
        email,
        password
      })
      .pipe(
        tap(response => {
          localStorage.setItem('foggerithm_token', response.token);
          localStorage.setItem(
            'foggerithm_user',
            JSON.stringify(response.user)
          );
        })
      );
  }

  register(
    request: RegisterRequest
  ): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(
      `${API_URL}/Auth/register`,
      request
    );
  }

  getToken(): string | null {
    return localStorage.getItem('foggerithm_token');
  }

  getUser(): AuthUser | null {
    const value = localStorage.getItem('foggerithm_user');

    if (!value) {
      return null;
    }

    try {
      return JSON.parse(value) as AuthUser;
    } catch {
      return null;
    }
  }

  isLoggedIn(): boolean {
    const token = this.getToken();

    if (!token) {
      return false;
    }

    try {
      const payload = token.split('.')[1];
      const claims = JSON.parse(atob(
        payload.replace(/-/g, '+').replace(/_/g, '/')
      ));

      if (!claims.exp || claims.exp * 1000 <= Date.now()) {
        this.logout();
        return false;
      }

      return true;
    } catch {
      this.logout();
      return false;
    }
  }

  logout(): void {
    localStorage.removeItem('foggerithm_token');
    localStorage.removeItem('foggerithm_user');
  }
}
