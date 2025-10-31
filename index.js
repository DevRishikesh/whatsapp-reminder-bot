/*
================================================================================
|                              SETUP INSTRUCTIONS                              |
================================================================================
|                                                                              |
| 1. Create a new folder for your project.                                     |
| 2. Inside that folder, create three files:                                   |
|    - 'package.json' (paste the content from step 1)                          |
|    - 'reminders.json' (paste the content from step 2, just '[]')             |
|    - 'index.js' (paste all the code below into this file)                    |
|                                                                              |
| 3. Open your computer's terminal or command prompt.                          |
| 4. Navigate into the project folder you created (e.g., cd my-bot-project).   |
| 5. Run this command to install the required libraries:                       |
|    npm install                                                               |
|                                                                              |
| 6. Run this command to start the bot:                                        |
|    node index.js                                                             |
|                                                                              |
| 7. A QR code will appear in your terminal. Scan it with your WhatsApp app    |
|    (in WhatsApp > Settings > Linked Devices > Link a Device).                |
|                                                                              |
| 8. Your bot is now online! It will create a '.wwebjs_auth' folder to         |
|    stay logged in, so you won't have to scan the QR code every time.         |
|                                                                              |
================================================================================
*/

// Import necessary libraries
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const schedule = require('node-schedule');
const chrono = require('chrono-node');
const fs = require('fs');

// Constants
const REMINDERS_FILE = './reminders.json';
const BOT_TAG = '@bot';

// Initialize the WhatsApp client
// We use LocalAuth to save the session and avoid scanning the QR code on every run
const client = new Client({
    authStrategy: new LocalAuth()
});

console.log('Starting bot...');

// -----------------------------------------------------------------------------
// WHATSAPP CLIENT EVENTS
// -----------------------------------------------------------------------------

// 1. Fired when a QR code is available
client.on('qr', (qr) => {
    console.log('QR code received! Scan it with your phone.');
    // Generate and display the QR code in the terminal
    qrcode.generate(qr, { small: true });
});

// 2. Fired when authentication is successful
client.on('authenticated', () => {
    console.log('Authenticated successfully!');
});

// 3. Fired when the bot is ready to be used
client.on('ready', () => {
    console.log('Client is ready! Listening for messages...');
    // Load and reschedule reminders from the JSON file on startup
    rescheduleReminders();
});

// 4. Fired when a message is received
client.on('message', async (message) => {
    // Check if the message is from a group and mentions the bot
    if (message.body.startsWith(BOT_TAG)) {
        const chat = await message.getChat();
        
        // Only respond in groups
        if (chat.isGroup) {
            console.log(`Received command from group: ${chat.name}`);
            const text = message.body.substring(BOT_TAG.length).trim();
            handleCommand(message, text, chat.id._serialized);
        }
    }
});

// 5. Fired on authentication failure
client.on('auth_failure', (msg) => {
    console.error('Authentication failed:', msg);
});

// Start the client
client.initialize();

// -----------------------------------------------------------------------------
// COMMAND HANDLER
// -----------------------------------------------------------------------------

/**
 * Handles incoming commands for the bot
 * @param {Message} message - The whatsapp-web.js message object
 * @param {string} commandText - The text of the command after "@bot"
 * @param {string} chatId - The ID of the chat
 */
async function handleCommand(message, commandText, chatId) {
    
    // Command: "@bot list reminders"
    if (commandText.toLowerCase() === 'list reminders') {
        listReminders(message, chatId);
        return;
    }

    // Command: "@bot [date] [reminder text]"
    try {
        // Use chrono-node to parse the date from the command
        const results = chrono.parse(commandText);
        
        if (results.length === 0) {
            message.reply("Sorry, I couldn't understand the date or time. Try something like:\n\n*@bot next Monday exam fees are due*");
            return;
        }

        // Extract date and reminder text
        const parsedDate = results[0].start.date();
        const dateText = results[0].text;
        const reminderSubject = commandText.replace(dateText, '').replace(/  +/g, ' ').trim();

        if (!reminderSubject) {
             message.reply("Please provide a subject for the reminder. Example:\n*@bot tomorrow submit the assignment*");
            return;
        }

        // Calculate the reminder time (one day before the parsed date at 9:00 AM)
        const remindAt = new Date(parsedDate.getTime());
        remindAt.setDate(remindAt.getDate() - 1); // Set to one day before
        remindAt.setHours(9, 0, 0, 0); // Set time to 9:00 AM

        // Check if the reminder date is in the past
        if (remindAt < new Date()) {
            message.reply("That date is too soon or already in the past! I can't set a reminder for it.");
            return;
        }

        // Format the final reminder message
        const reminderMessage = `🔔 *REMINDER* 🔔\n\nTomorrow: ${reminderSubject} 📅`;

        // Schedule the reminder and get its unique ID
        const jobId = scheduleNewReminder(chatId, reminderMessage, remindAt);

        // Save the reminder to our JSON file
        const newReminder = {
            id: jobId,
            chatId: chatId,
            reminderMessage: reminderMessage,
            remindAt: remindAt.toISOString(),
            originalSubject: reminderSubject, // For the "list" command
            originalDate: parsedDate.toISOString()
        };

        const reminders = loadReminders();
        reminders.push(newReminder);
        saveReminders(reminders);

        // Confirm to the user
        message.reply(`Got it! 👍\n\nI'll remind this group on *${remindAt.toLocaleString()}*.`);

    } catch (error) {
        console.error('Error parsing command:', error);
        message.reply("Oops, something went wrong. Please try again.");
    }
}

// -----------------------------------------------------------------------------
// REMINDER SCHEDULING & MANAGEMENT
// -----------------------------------------------------------------------------

/**
 * Creates a new scheduled job and returns its name (ID)
 * @param {string} chatId - The ID of the chat to send the message to
 * @param {string} message - The reminder message to send
 * @param {Date} date - The Date object specifying when to send the reminder
 * @returns {string} The unique ID of the scheduled job
 */
function scheduleNewReminder(chatId, message, date) {
    // Generate a unique ID for the job
    const jobId = `reminder_${chatId}_${date.getTime()}`;

    schedule.scheduleJob(jobId, date, async () => {
        try {
            console.log(`Sending reminder (Job ID: ${jobId}) to ${chatId}`);
            await client.sendMessage(chatId, message);
            
            // Once sent, remove it from the JSON file
            removeReminder(jobId);
        } catch (err) {
            console.error('Failed to send reminder:', err);
        }
    });

    console.log(`Scheduled new reminder: ${jobId}`);
    return jobId;
}

/**
 * Loads all reminders from the JSON file and reschedules them
 */
function rescheduleReminders() {
    const reminders = loadReminders();
    const now = new Date();
    let validReminders = []; // To store reminders that are still in the future

    console.log(`Loading ${reminders.length} reminders from file...`);

    for (const reminder of reminders) {
        const remindAt = new Date(reminder.remindAt);
        
        // Only reschedule reminders that are still in the future
        if (remindAt > now) {
            scheduleNewReminder(reminder.chatId, reminder.reminderMessage, remindAt);
            validReminders.push(reminder);
        } else {
            console.log(`Skipping past reminder: ${reminder.id}`);
        }
    }

    // Save the cleaned list back to the file (removes old, past reminders)
    saveReminders(validReminders);
    console.log(`Rescheduled ${validReminders.length} upcoming reminders.`);
}

/**
 * Lists all upcoming reminders for a specific chat
 * @param {Message} message - The original message object to reply to
 * @param {string} chatId - The ID of the chat
 */
function listReminders(message, chatId) {
    const reminders = loadReminders();
    // Filter reminders for the current group
    const groupReminders = reminders.filter(r => r.chatId === chatId);

    if (groupReminders.length === 0) {
        message.reply("There are no upcoming reminders for this group.  Zilch! Nada! 🎉");
        return;
    }

    let reply = "⏰ *Upcoming Reminders for this Group* ⏰\n";
    groupReminders.sort((a, b) => new Date(a.remindAt) - new Date(b.remindAt)); // Sort by date

    for (const r of groupReminders) {
        const remindDate = new Date(r.remindAt);
        const originalEventDate = new Date(r.originalDate);
        reply += `\n-----------------------------\n`;
        reply += `*Subject:* ${r.originalSubject}\n`;
        reply += `*Event Date:* ${originalEventDate.toLocaleDateString()}\n`;
        reply += `*Reminder On:* ${remindDate.toLocaleString()}`;
    }
    
    message.reply(reply);
}

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS (File System)
// -----------------------------------------------------------------------------

/**
 * Reads and parses reminders from the JSON file
 * @returns {Array} An array of reminder objects
 */
function loadReminders() {
    try {
        if (!fs.existsSync(REMINDERS_FILE)) {
            fs.writeFileSync(REMINDERS_FILE, '[]', 'utf8');
            return [];
        }
        const data = fs.readFileSync(REMINDERS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('Error loading reminders:', err);
        return []; // Return an empty array on error
    }
}

/**
 * Saves an array of reminders to the JSON file
 * @param {Array} reminders - The array of reminder objects to save
 */
function saveReminders(reminders) {
    try {
        const data = JSON.stringify(reminders, null, 2); // Pretty-print JSON
        fs.writeFileSync(REMINDERS_FILE, data, 'utf8');
    } catch (err) {
        console.error('Error saving reminders:', err);
    }
}

/**
 * Removes a single reminder from the JSON file by its job ID
 * @param {string} jobId - The ID of the job/reminder to remove
 */
function removeReminder(jobId) {
    console.log(`Removing reminder ${jobId} from file.`);
    const reminders = loadReminders();
    const updatedReminders = reminders.filter(r => r.id !== jobId);
    saveReminders(updatedReminders);
}
