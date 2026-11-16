"""Sugar onboarding survey_step 0–3 (n8n package as step 2)

Revision ID: 0024_pre_influencers_step3
Revises: 0023_pre_influencers_model_id
Create Date: 2026-11-16

Sugar Scratchie now mirrors TeaseMe's 3-step completion count:
  1 Email & Name → 2 Make package (n8n) → 3 Make landing page.
Rows already live at the old step 2 (Order LP done) move to step 3.
"""

from alembic import op

revision = "0024_pre_influencers_step3"
down_revision = "0023_pre_influencers_model_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE pre_influencers DROP CONSTRAINT IF EXISTS pre_influencers_survey_step_chk;
        UPDATE pre_influencers
           SET survey_step = 3
         WHERE status = 'live' AND survey_step = 2;
        ALTER TABLE pre_influencers ADD CONSTRAINT pre_influencers_survey_step_chk
            CHECK (survey_step >= 0 AND survey_step <= 3);
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE pre_influencers
           SET survey_step = 2
         WHERE survey_step > 2;
        ALTER TABLE pre_influencers DROP CONSTRAINT IF EXISTS pre_influencers_survey_step_chk;
        ALTER TABLE pre_influencers ADD CONSTRAINT pre_influencers_survey_step_chk
            CHECK (survey_step >= 0 AND survey_step <= 2);
        """
    )
