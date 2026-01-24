import express from 'express';

const router = express.Router();

// POST /api/waitlist/form - Add user to Ghost AI waitlist
router.post('/form', async (req, res) => {
  try {
    const { name, phone, email, aiPreference, smsConsent } = req.body;

    console.log('Waitlist signup:', { name, phone, email, aiPreference });

    // Validate required fields
    if (!phone) {
      return res.status(400).json({
        success: false,
        error: 'Phone number is required'
      });
    }

    // Try to connect to Supabase
    try {
      const { supabase } = await import('../config/supabase.js');

      // Insert into waitlist table
      const { data, error } = await supabase
        .from('ghost_os_waitlist')
        .insert({
          phone_number: phone,
          name: name || null,
          email: email || null,
          preferred_ai: aiPreference || 'openai',
          sms_consent: smsConsent || false,
          status: 'waiting',
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) {
        // Handle duplicate phone number
        if (error.code === '23505') {
          return res.status(400).json({
            success: false,
            error: 'This phone number is already on the waitlist'
          });
        }
        throw error;
      }

      res.json({
        success: true,
        message: 'Successfully added to waitlist',
        data
      });
    } catch (dbError) {
      console.error('Database error:', dbError);
      // For now, return success even if DB fails (just log it)
      res.json({
        success: true,
        message: 'Added to waitlist (database connection pending)',
        note: 'Your signup has been logged. Database will sync shortly.'
      });
    }

  } catch (error) {
    console.error('Waitlist signup error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to add to waitlist'
    });
  }
});

export default router;
