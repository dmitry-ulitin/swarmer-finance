import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TuiButton, TuiError, TuiIcon, TuiInput, TuiLink } from '@taiga-ui/core';
import { AuthService } from '../../core/auth.service';
import { TuiPassword } from '@taiga-ui/kit';
import { TuiValidationError } from '@taiga-ui/cdk/classes';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule, TuiLink, RouterLink, TuiButton, TuiInput, TuiPassword, TuiIcon, TuiError],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginComponent {
  private authService = inject(AuthService);
  private router = inject(Router);

  form = new FormGroup({
    email: new FormControl('', [Validators.required, Validators.email]),
    password: new FormControl('', [Validators.required])
  });

  loading = signal(false);
  error = signal<TuiValidationError | null>(null);

  async onSubmit(event: Event) {
    event.preventDefault();
    if (this.form.invalid) return;
    
    this.loading.set(true);
    this.error.set(null);

    try {
      await firstValueFrom(this.authService.login(
        this.form.value.email!,
        this.form.value.password!
      ));
      this.router.navigate(['/dashboard']);
    } catch (err) {
      this.loading.set(false);
      this.error.set(new TuiValidationError((err as any).error?.error || 'Login failed'));
    }
  }
} 
