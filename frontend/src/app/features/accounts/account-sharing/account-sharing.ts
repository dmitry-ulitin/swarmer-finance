import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { TuiButton, TuiDialogService, TuiInput } from '@taiga-ui/core';
import type { TuiDialogContext } from '@taiga-ui/core';
import { TUI_CONFIRM, type TuiConfirmData, TuiChevron, TuiDataListWrapper, TuiSelect, TuiStringifyContentPipe } from '@taiga-ui/kit';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { firstValueFrom, type Observable } from 'rxjs';
import { ApiService, type ApiResponse } from '../../../core/api.service';
import { AuthService } from '../../../core/auth.service';
import { AccountsState } from '../../../core/accounts.state';
import { CategoriesState } from '../../../core/categories.state';
import { TransactionsState } from '../../../core/transactions.state';
import { NotificationService } from '../../../core/notification.service';
import { LEVEL_LABELS, type Account, type AccountMember, type ShareLevel } from '../../../models/account';

const SHARE_LEVELS: readonly ShareLevel[] = [1, 2, 3];

@Component({
  selector: 'app-account-sharing',
  imports: [ReactiveFormsModule, FormsModule, TuiInput, TuiButton, TuiChevron, TuiSelect, TuiDataListWrapper, TuiStringifyContentPipe],
  templateUrl: './account-sharing.html',
  styleUrl: './account-sharing.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountSharing {
  private readonly context = inject<TuiDialogContext<void, Account>>(POLYMORPHEUS_CONTEXT);
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly accountsState = inject(AccountsState);
  private readonly categoriesState = inject(CategoriesState);
  private readonly transactionsState = inject(TransactionsState);
  private readonly notifications = inject(NotificationService);
  private readonly dialogs = inject(TuiDialogService);

  private readonly account = this.context.data;

  readonly levels = SHARE_LEVELS;
  readonly levelLabel = (level: number): string => LEVEL_LABELS[level as ShareLevel];
  readonly busy = signal(false);
  readonly members = signal<AccountMember[]>([]);
  readonly me = computed(() => this.members().find(m => m.user_id === this.auth.user()?.id) ?? null);
  readonly canManage = computed(() => (this.me()?.level ?? 0) >= 3);
  /** The Owner of a personal account cannot leave it, only delete it. */
  readonly canLeave = computed(() => !!this.me() && this.me()!.level !== 4);

  readonly form = new FormGroup({
    email: new FormControl<string>('', { nonNullable: true, validators: [Validators.required] }),
    level: new FormControl<ShareLevel>(1, { nonNullable: true }),
  });

  constructor() {
    this.api.getAccountShares(this.account.id).subscribe({
      next: r => this.members.set(r.data ?? []),
      error: e => this.notifications.showError(e, 'Failed to load sharing'),
    });
  }

  isMe(member: AccountMember): boolean {
    return member.user_id === this.me()?.user_id;
  }

  async add(): Promise<void> {
    if (this.form.invalid) return;
    const { email, level } = this.form.getRawValue();
    if (level === 3 && !await this.confirmCoOwner(email.trim())) return;
    const ok = await this.mutate(this.api.addAccountShare(this.account.id, email.trim(), level));
    if (ok) this.form.reset();
  }

  async changeLevel(member: AccountMember, level: ShareLevel): Promise<void> {
    if (level === member.level) return;
    const who = member.name || member.email;
    // Moving another creator below co-owner hands ownership to the caller.
    const confirmed = member.is_creator && level < 3 && !this.isMe(member)
      ? await this.confirm('Change level', `${who} created "${this.account.name}". Changing their level makes you the owner.`, 'Change level')
      : level !== 3 || await this.confirmCoOwner(who);
    if (!confirmed) {
      this.refreshRows();
      return;
    }
    if (!await this.mutate(this.api.updateAccountShare(this.account.id, member.user_id, level))) this.refreshRows();
  }

  async remove(member: AccountMember): Promise<void> {
    if (this.isMe(member)) return this.leave();
    const content = `Remove ${member.name || member.email} from "${this.account.name}"? Their income and expenses on this account pass to the owner.`;
    if (!await this.confirm('Remove member', content, 'Remove')) return;
    await this.mutate(this.api.removeAccountShare(this.account.id, member.user_id));
  }

  async leave(): Promise<void> {
    const me = this.me();
    if (!me || !await this.confirm('Leave account', `Leave "${this.account.name}"? You will lose access to it.`, 'Leave')) return;
    if (await this.mutate(this.api.removeAccountShare(this.account.id, me.user_id))) this.context.completeWith();
  }

  /** Granting co-owner on a personal account gives up sole ownership. */
  private confirmCoOwner(who: string): Promise<boolean> {
    if (this.me()?.level !== 4) return Promise.resolve(true);
    return this.confirm(
      'Make co-owner',
      `"${this.account.name}" becomes co-owned: you will have equal rights with ${who}.`,
      'Make co-owner',
    );
  }

  private confirm(label: string, content: string, yes: string): Promise<boolean> {
    const data: TuiConfirmData = { content, yes, no: 'Cancel' };
    return firstValueFrom(this.dialogs.open<boolean>(TUI_CONFIRM, { label, size: 's', data }), { defaultValue: false });
  }

  /** Re-renders the rows, so a select left on an unapplied level shows the stored one again. */
  private refreshRows(): void {
    this.members.update(list => list.map(m => ({ ...m })));
  }

  private async mutate(request: Observable<ApiResponse<AccountMember[]>>): Promise<boolean> {
    this.busy.set(true);
    try {
      const r = await firstValueFrom(request);
      const members = r.data ?? [];
      this.members.set(members);
      this.accountsState.reload();
      this.categoriesState.reload();
      // A filter still naming an account the user just left would show nothing.
      if (members.some(m => m.user_id === this.auth.user()?.id)) this.transactionsState.reload();
      else this.transactionsState.reloadWithout(this.account.id);
      return true;
    } catch (e) {
      this.notifications.showError(e, 'Failed to update sharing');
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
