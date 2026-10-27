import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { TuiButton, TuiDataList, TuiDialogService, TuiLoader, TuiTextfield } from '@taiga-ui/core';
import { TUI_CONFIRM, TuiChevron, TuiChip, TuiDataListWrapper, TuiFiles, TuiSelect, TuiTextarea, type TuiConfirmData } from '@taiga-ui/kit';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../../core/api.service';
import { NotificationService } from '../../../core/notification.service';
import {
  BANK_COUNTRIES,
  bankRedirectUrl,
  type BankAspsp,
  type BankConnection,
  type BankCredentials,
} from '../../../models/bank';

const DAY = 24 * 60 * 60 * 1000;

@Component({
  selector: 'app-bank-connections',
  imports: [
    ReactiveFormsModule,
    TuiButton,
    TuiChevron,
    TuiChip,
    TuiDataList,
    TuiDataListWrapper,
    TuiFiles,
    TuiLoader,
    TuiSelect,
    TuiTextarea,
    TuiTextfield,
  ],
  templateUrl: './bank-connections.html',
  styleUrl: './bank-connections.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BankConnections {
  private readonly api = inject(ApiService);
  private readonly dialogs = inject(TuiDialogService);
  private readonly notifications = inject(NotificationService);

  readonly redirectUrl = bankRedirectUrl();
  readonly countries = BANK_COUNTRIES;

  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly info = signal<BankCredentials | null>(null);
  readonly connections = signal<BankConnection[]>([]);
  readonly aspsps = signal<BankAspsp[]>([]);
  readonly bankNames = computed(() => this.aspsps().map(a => a.name));

  readonly form = new FormGroup({
    applicationId: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    // Never filled from the server: the key is write-only.
    privateKey: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });
  readonly keyFile = new FormControl<File | null>(null);
  readonly connectForm = new FormGroup({
    country: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    bank: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  /** Connections with their status chip text, as shown. */
  readonly rows = computed(() => this.connections().map(c => ({
    ...c,
    statusText: statusText(c),
    bankAccounts: c.accounts.map(a => ({
      uid: a.uid,
      label: `${a.name || a.iban || a.uid} (${a.currency === 'XXX' ? 'multi-currency' : a.currency})`,
    })),
  })));

  constructor() {
    this.keyFile.valueChanges.pipe(takeUntilDestroyed()).subscribe(file => {
      if (file) void this.readKey(file);
    });
    this.connectForm.controls.country.valueChanges.pipe(takeUntilDestroyed()).subscribe(country => {
      this.connectForm.controls.bank.setValue('');
      void this.loadAspsps(country);
    });
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const info = (await firstValueFrom(this.api.getBankCredentials())).data;
      this.info.set(info);
      if (info?.enabled) {
        this.form.controls.applicationId.setValue(info.applicationId ?? '');
        if (info.hasKey) await this.loadConnections();
      }
    } catch (e) {
      this.notifications.showError(e, 'Failed to load bank settings');
    } finally {
      this.loading.set(false);
    }
  }

  private async loadConnections(): Promise<void> {
    this.connections.set((await firstValueFrom(this.api.getBankConnections())).data ?? []);
  }

  private async loadAspsps(country: string): Promise<void> {
    this.aspsps.set([]);
    if (!country) return;
    try {
      const aspsps = (await firstValueFrom(this.api.getBankAspsps(country))).data ?? [];
      if (this.connectForm.controls.country.value === country) this.aspsps.set(aspsps);
    } catch (e) {
      this.notifications.showError(e, 'Failed to load banks');
    }
  }

  private async readKey(file: File): Promise<void> {
    try {
      this.form.controls.privateKey.setValue((await file.text()).trim());
    } catch (e) {
      this.notifications.showError(e, 'Failed to read the key file');
    }
  }

  async saveKey(): Promise<void> {
    if (this.form.invalid) return;
    const { applicationId, privateKey } = this.form.getRawValue();
    await this.run(async () => {
      const info = (await firstValueFrom(this.api.saveBankCredentials({
        applicationId: applicationId.trim(),
        privateKey: privateKey.trim(),
      }))).data;
      this.info.set(info);
      this.form.controls.privateKey.reset('');
      this.notifications.showSuccess('Key saved');
      await this.loadConnections();
    }, 'Failed to save the key');
  }

  async removeKey(): Promise<void> {
    await this.run(async () => {
      await firstValueFrom(this.api.deleteBankCredentials());
      this.info.update(i => (i ? { ...i, applicationId: null, hasKey: false } : i));
      this.form.reset({ applicationId: '', privateKey: '' });
      this.connections.set([]);
    }, 'Failed to remove the key');
  }

  async connect(): Promise<void> {
    if (this.connectForm.invalid) return;
    const { country, bank } = this.connectForm.getRawValue();
    await this.run(async () => {
      const result = (await firstValueFrom(this.api.startBankConnection(bank, country))).data;
      if (result) this.redirect(result.url);
    }, 'Failed to start the connection');
  }

  async reconnect(connection: BankConnection): Promise<void> {
    await this.run(async () => {
      const result = (await firstValueFrom(this.api.reconnectBank(connection.id))).data;
      if (result) this.redirect(result.url);
    }, 'Failed to reconnect');
  }

  async disconnect(connection: BankConnection): Promise<void> {
    const data: TuiConfirmData = {
      content: `Disconnect "${connection.aspspName}"? Accounts linked to it stop loading transactions.`,
      yes: 'Disconnect',
      no: 'Cancel',
    };
    const confirmed = await firstValueFrom(
      this.dialogs.open<boolean>(TUI_CONFIRM, { label: 'Disconnect Bank', size: 's', data }),
      { defaultValue: false }
    );
    if (!confirmed) return;
    await this.run(async () => {
      await firstValueFrom(this.api.deleteBankConnection(connection.id));
      await this.loadConnections();
    }, 'Failed to disconnect');
  }

  /** Hands the browser over to the bank's consent page. */
  redirect(url: string): void {
    location.assign(url);
  }

  private async run(action: () => Promise<void>, failure: string): Promise<void> {
    try {
      this.busy.set(true);
      await action();
    } catch (e) {
      this.notifications.showError(e, failure);
    } finally {
      this.busy.set(false);
    }
  }
}

function statusText(c: BankConnection): string {
  switch (c.status) {
    case 'pending': return 'Not completed';
    case 'expired': return 'Expired';
    case 'expiring': {
      const days = Math.max(0, Math.ceil((new Date(c.validUntil ?? 0).getTime() - Date.now()) / DAY));
      return `Expires in ${days} day${days === 1 ? '' : 's'}`;
    }
    default:
      return c.validUntil ? `Active until ${new Date(c.validUntil).toLocaleDateString()}` : 'Active';
  }
}
