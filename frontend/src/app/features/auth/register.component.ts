import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TuiButton, TuiError, TuiIcon, TuiInput, TuiLink } from '@taiga-ui/core';
import { TuiPassword } from '@taiga-ui/kit';
import { TuiValidationError } from '@taiga-ui/cdk/classes';
import { AuthService } from '../../core/auth.service';
import { firstValueFrom } from 'rxjs/internal/firstValueFrom';

@Component({
  selector: 'app-register',
  imports: [ReactiveFormsModule, RouterLink, TuiButton, TuiError, TuiIcon, TuiLink, TuiInput, TuiPassword],
  templateUrl: './register.component.html',
  styleUrl: './register.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegisterComponent {
  private authService = inject(AuthService);
  private router = inject(Router);

  form = new FormGroup({
    email: new FormControl('', [Validators.required, Validators.email]),
    password: new FormControl('', [Validators.required, Validators.minLength(6)]),
    name: new FormControl(''),
    currency: new FormControl('')
  });

  loading = signal(false);
  error = signal<TuiValidationError | null>(null);

  async onSubmit(event: Event) {
    event.preventDefault();
    if (this.form.invalid) return;

    this.loading.set(true);
    this.error.set(null);

    try {
      await firstValueFrom(this.authService.register(
        this.form.value.email!,
        this.form.value.password!,
        this.form.value.name!,
        this.form.value.currency!
      ));
      this.router.navigate(['/dashboard']);
    } catch (err) {
      this.loading.set(false);
      this.error.set(new TuiValidationError((err as any).error?.error || 'Registration failed'));
    }
  }
}
