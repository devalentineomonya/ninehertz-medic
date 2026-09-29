/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { streamText, tool } from 'ai';
import { Cache } from 'cache-manager';
import { Response } from 'express';
import { AppointmentService } from 'src/appointment/appointment.service';
import {
  AppointmentMode,
  AppointmentType,
} from 'src/appointment/entities/appointment.entity';
import { DoctorService } from 'src/doctor/doctor.service';
import { DaysOfWeek } from 'src/doctor/dto/availability-slot.dto';
import { DoctorFilterDto } from 'src/doctor/dto/doctor-filter.dto';
import { AppointmentStatus } from 'src/enums/appointment.enum';
import { PatientService } from 'src/patient/patient.service';
import { PharmacistService } from 'src/pharmacist/pharmacist.service';
import { PrescriptionService } from 'src/prescription/prescription.service';
import { UserRole } from 'src/user/entities/user.entity';
import { z } from 'zod/v4';
import { CreateChatDto, MessageDto } from './dto/create-chat.dto';

interface PaginationDto {
  page: number;
  limit: number;
}

interface UserContext {
  userId: string;
  role: UserRole;
  patientId?: string;
  doctorId?: string;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly google: ReturnType<typeof createGoogleGenerativeAI>;
  private readonly model: string = 'gemini-2.0-flash';

  // Rate limiting constants
  private readonly RATE_LIMIT_COUNT = 10;
  private readonly RATE_LIMIT_TTL = 86400;

  // Timeout constants
  private readonly RESPONSE_TIMEOUT = 30000;
  private readonly STREAM_TIMEOUT = 45000;

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly configService: ConfigService,
    private readonly doctorService: DoctorService,
    private readonly appointmentService: AppointmentService,
    private readonly patientService: PatientService,
    private readonly prescriptionService: PrescriptionService,
    private readonly pharmacistService: PharmacistService,
  ) {
    const apiKey = String(this.configService.getOrThrow('GEMINI_API_KEY'));
    this.google = createGoogleGenerativeAI({
      apiKey,
    });
  }

  async testModel() {
    try {
      this.logger.debug('Testing Google Gemini connection...');

      const testPayload = {
        model: this.google(this.model),
        temperature: 0.9,
        maxTokens: 15,
        messages: [
          {
            role: 'system' as const,
            content:
              'You are a test validator. Respond ONLY with "TEST_SUCCESS"',
          },
          {
            role: 'user' as const,
            content: 'What is the test validation code?',
          },
        ],
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      let response = '';
      let chunkCount = 0;

      this.logger.debug('Sending request to Gemini...');
      const startTime = Date.now();

      try {
        const result = streamText({
          ...testPayload,
          abortSignal: controller.signal,
        });

        for await (const delta of result.textStream) {
          response += delta;
          chunkCount++;
          this.logger.verbose(`Received chunk ${chunkCount}: ${delta}`);
        }
      } finally {
        clearTimeout(timeoutId);
      }

      const duration = Date.now() - startTime;
      this.logger.debug(
        `Response: '${response}' | Chunks: ${chunkCount} | Time: ${duration}ms`,
      );

      if (!response.trim().toUpperCase().includes('TEST_SUCCESS')) {
        throw new Error(`Invalid response: '${response}'`);
      }

      return { response, chunkCount, success: true };
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.logger.error('Gemini request timed out');
      } else if (
        error instanceof Error &&
        'response' in error &&
        (error as Record<string, any>).response?.data?.error
      ) {
        this.logger.error(
          'Gemini API Error:',
          (error as Record<string, any>).response.data.error,
        );
      } else if (error instanceof Error) {
        this.logger.error('Test Failed', {
          message: error.message,
          stack: error.stack,
        });
      } else {
        this.logger.error('Test Failed', { message: String(error) });
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Gemini test failed: ${message}`);
    }
  }

  async handleRequest({
    ip,
    createChatDto,
    res,
    userId,
    userRole,
  }: {
    ip: string;
    createChatDto: CreateChatDto;
    res: Response;
    userId: string;
    userRole: UserRole;
  }): Promise<void> {
    const requestTimeout = setTimeout(() => {
      if (!res.headersSent) {
        this.logger.error('Request timeout - sending 408');
        res.status(408).json({
          error: 'Request timeout',
          message: 'The request took too long to process. Please try again.',
        });
      }
    }, this.RESPONSE_TIMEOUT);

    try {
      this.logger.log(
        `Handling request for user: ${userId}, role: ${userRole}, IP: ${ip}`,
      );

      const isBlocked = await this.cacheManager.get(`blocked:${ip}`);
      if (isBlocked) {
        this.logger.warn(`Blocked IP attempted request: ${ip}`);
        this.sendRateLimitResponse(res);
        return;
      }

      const countKey = `count:${ip}`;
      const count = (await this.cacheManager.get<number>(countKey)) ?? 0;

      if (count >= this.RATE_LIMIT_COUNT) {
        this.logger.warn(`Rate limit exceeded for IP: ${ip}`);
        await this.cacheManager.set(`blocked:${ip}`, true, this.RATE_LIMIT_TTL);
        this.sendRateLimitResponse(res);
        return;
      }

      await this.cacheManager.set(countKey, count + 1, this.RATE_LIMIT_TTL);
      this.logger.log(`Rate limit updated for IP: ${ip}, count: ${count + 1}`);

      const { messages } = createChatDto;

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        throw new Error('Invalid or empty messages array');
      }

      this.logger.log(`Processing ${messages.length} messages`);

      const userContext = await this.getUserContext(userId, userRole);
      this.logger.log(
        `User context determined: ${JSON.stringify(userContext)}`,
      );

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Transfer-Encoding', 'chunked');

      await this.generateMedicalResponse(messages, userContext, res);

      clearTimeout(requestTimeout);
      this.logger.log('Request completed successfully');
    } catch (error) {
      clearTimeout(requestTimeout);
      this.logger.error('Generation error:', error);
      this.handleResponseError(res, error);
    }
  }

  private async getUserContext(
    userId: string,
    role: UserRole,
  ): Promise<UserContext> {
    const context: UserContext = { userId, role };

    try {
      this.logger.log(`Setting user context for: ${userId}, role: ${role}`);

      switch (role) {
        case UserRole.PATIENT: {
          const patient = await this.patientService.findByUserId(userId);
          if (patient) {
            context.patientId = patient.id;
            this.logger.log(`Patient ID set: ${patient.id}`);
          } else {
            this.logger.warn(`Patient not found for user: ${userId}`);
            throw new Error('Patient profile not found');
          }
          break;
        }
        case UserRole.DOCTOR: {
          const doctor = await this.doctorService.findByUserId?.(userId);
          if (doctor) {
            context.doctorId = doctor.id;
            this.logger.log(`Doctor ID set: ${doctor.id}`);
          } else {
            this.logger.warn(`Doctor not found for user: ${userId}`);
            throw new Error('Doctor profile not found');
          }
          break;
        }
        case UserRole.PHARMACIST: {
          const pharmacist =
            await this.pharmacistService.findByUserId?.(userId);
          if (pharmacist) {
            context.doctorId = pharmacist.id;
            this.logger.log(`Pharmacist ID set: ${pharmacist.id}`);
          } else {
            this.logger.warn(`Pharmacist not found for user: ${userId}`);
            throw new Error('Pharmacist profile not found');
          }
          break;
        }
        case UserRole.ADMIN: {
          this.logger.log('Admin role set - no additional ID needed');
          break;
        }
        default: {
          this.logger.warn(
            `Unknown role: ${role as string}, defaulting to patient`,
          );
          context.role = UserRole.PATIENT;
          break;
        }
      }

      return context;
    } catch (error) {
      this.logger.error('Error setting user context:', error);
      throw error;
    }
  }

  private sendRateLimitResponse(res: Response): void {
    if (!res.headersSent) {
      res.status(429).json({
        error: 'Rate limit exceeded',
        message:
          'You have reached the message limit for today. Please try again later.',
      });
    }
  }

  private handleResponseError(res: Response, error: unknown): void {
    const errorMessage =
      error instanceof Error ? error.message : 'Response generation failed';
    this.logger.error('Handling response error:', errorMessage);
    if (!res.headersSent) {
      res.status(500).json({ error: errorMessage });
    }
  }

  private normalizeSpecialty(specialty: string): string {
    if (!specialty || typeof specialty !== 'string') return specialty;
    const specialties: Record<string, string> = {
      cardio: 'Cardiology',
      heart: 'Cardiology',
      dermatology: 'Dermatology',
      skin: 'Dermatology',
      neuro: 'Neurology',
      brain: 'Neurology',
      ortho: 'Orthopedics',
      bone: 'Orthopedics',
      pediatric: 'Pediatrics',
      gynecology: 'Gynecology',
      psychiatry: 'Psychiatry',
      oncology: 'Oncology',
    };
    return specialties[specialty.toLowerCase()] || specialty;
  }

  private normalizeDayOfWeek(day: string): string {
    if (!day || typeof day !== 'string') return day;
    const days: Record<string, string> = {
      mon: 'Monday',
      tue: 'Tuesday',
      wed: 'Wednesday',
      thu: 'Thursday',
      fri: 'Friday',
      sat: 'Saturday',
      sun: 'Sunday',
      monday: 'Monday',
      tuesday: 'Tuesday',
      wednesday: 'Wednesday',
      thursday: 'Thursday',
      friday: 'Friday',
      saturday: 'Saturday',
      sunday: 'Sunday',
    };
    return days[day.toLowerCase()] || day;
  }

  private isValidDayOfWeek(day: string): boolean {
    const validDays = [
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
      'Sunday',
    ];
    return validDays.includes(day);
  }

  private async generateMedicalResponse(
    messages: MessageDto[],
    userContext: UserContext,
    res: Response,
  ): Promise<void> {
    this.logger.log('Starting medical response generation');

    const streamTimeout = setTimeout(() => {
      this.logger.error('Stream timeout occurred');
      if (!res.destroyed && !res.writableEnded) {
        res.write('\n\nResponse timeout. Please try again.');
        res.end();
      }
    }, this.STREAM_TIMEOUT);

    try {
      const tools = this.getTools(userContext);
      const systemMessage = this.getSystemMessage(userContext);

      this.logger.log(`System message length: ${systemMessage.content.length}`);
      this.logger.log(
        `Number of tools available: ${Object.keys(tools).length}`,
      );

      const aiMessages = [
        systemMessage,
        ...messages.map((msg) => ({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        })),
      ];

      this.logger.log(
        'Calling Google Gemini API with messages:',
        aiMessages.length,
      );
      this.logger.log(
        'AI Messages structure:',
        JSON.stringify(aiMessages, null, 2),
      );

      const result = streamText({
        model: this.google(this.model),
        messages: aiMessages,
        tools,
        maxOutputTokens: 1024,
        temperature: 0.7,
      });

      this.logger.log('Stream result created successfully');

      let hasStarted = false;
      let chunkCount = 0;
      let totalContent = '';

      try {
        Promise.resolve(result.response)
          .then((response) => {
            this.logger.log(
              `AI Response received - Messages: ${JSON.stringify(response.messages)}, Headers: ${JSON.stringify(response.headers)}`,
            );
          })
          .catch((error: unknown) => {
            this.logger.error(`AI Response promise error:`, error);
          });

        const streamPromise = (async () => {
          for await (const delta of result.textStream) {
            if (res.destroyed || res.writableEnded) {
              this.logger.warn('Response stream ended prematurely');
              break;
            }
            if (!hasStarted) {
              this.logger.log('First chunk received, streaming started');
              hasStarted = true;
            }
            chunkCount++;
            totalContent += delta;
            res.write(delta);
            if (chunkCount % 5 === 0) {
              this.logger.log(
                `Streamed ${chunkCount} chunks, latest chunk: "${delta.substring(0, 50)}..."`,
              );
            }
          }
        })();

        await Promise.race([
          streamPromise,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('Stream iteration timeout')),
              30000,
            ),
          ),
        ]);
      } catch (streamError) {
        this.logger.error('Error in text stream iteration:', streamError);
        try {
          this.logger.log('Attempting to get full text as fallback...');
          const fullText = await result.text;
          this.logger.log(
            `Fallback text received: ${fullText.length} characters`,
          );
          if (fullText && fullText.length > 0) {
            if (!res.destroyed && !res.writableEnded) {
              res.write(fullText);
              totalContent = fullText;
              chunkCount = 1;
            }
          }
        } catch (fallbackError) {
          this.logger.error('Fallback text retrieval failed:', fallbackError);
          if (!res.destroyed && !res.writableEnded) {
            res.write('\n\nSorry, there was an error in the response stream.');
          }
        }
      }

      clearTimeout(streamTimeout);
      this.logger.log(
        `Final stats - Chunks: ${chunkCount}, Content length: ${totalContent.length}`,
      );

      if (chunkCount === 0) {
        this.logger.warn(
          'No chunks received - attempting direct API call for debugging...',
        );
        try {
          const testResult = streamText({
            model: this.google(this.model),
            messages: [{ role: 'user', content: 'Say hello' }],
            maxOutputTokens: 50,
          });
          const testText = await testResult.text;
          this.logger.log(`Test call successful: ${testText}`);
          if (!res.destroyed && !res.writableEnded) {
            res.write(
              'I apologize, but I encountered a streaming issue. However, I can confirm the connection is working. Please try your request again.',
            );
          }
        } catch (testError) {
          this.logger.error('Test call also failed:', testError);
          if (!res.destroyed && !res.writableEnded) {
            res.write(
              'I apologize, but I encountered an issue with the AI service. Please try again later.',
            );
          }
        }
      }

      if (!res.destroyed && !res.writableEnded) {
        res.end();
        this.logger.log(
          `Response streaming completed with ${chunkCount} chunks`,
        );
      }
    } catch (error) {
      clearTimeout(streamTimeout);
      this.logger.error('Error in generateMedicalResponse:', error);
      if (!res.destroyed && !res.writableEnded) {
        if (!res.headersSent) {
          res.status(500).json({
            error: 'Failed to generate response',
            message: error instanceof Error ? error.message : 'Unknown error',
          });
        } else {
          res.write('\n\nSorry, there was an error generating the response.');
          res.end();
        }
      }
      throw error;
    }
  }

  private getTools(userContext: UserContext) {
    this.logger.log('Setting up tools for user context');

    const listDoctorsInputSchema = z.object({
      specialty: z
        .string()
        .optional()
        .describe('Medical specialty to filter by (e.g., Cardiology)'),
    });
    type ListDoctorsInput = z.infer<typeof listDoctorsInputSchema>;

    const checkDoctorAvailabilityInputSchema = z.object({
      doctorName: z.string().describe('Name of the doctor'),
      dayOfWeek: z
        .string()
        .describe(
          'Day of the week (Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday)',
        ),
    });
    type CheckDoctorAvailabilityInput = z.infer<
      typeof checkDoctorAvailabilityInputSchema
    >;

    const listAvailableDoctorsByDayInputSchema = z.object({
      dayOfWeek: z
        .string()
        .describe(
          'Day of the week (Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday)',
        ),
      specialty: z
        .string()
        .optional()
        .describe('Medical specialty to filter by (e.g., Cardiology)'),
    });
    type ListAvailableDoctorsByDayInput = z.infer<
      typeof listAvailableDoctorsByDayInputSchema
    >;

    const bookAppointmentInputSchema = z.object({
      doctorId: z.string().describe('ID of the doctor'),
      userId: z.string().describe('ID of the user booking the appointment'),
      startTime: z
        .string()
        .describe('Start time in ISO format (YYYY-MM-DDTHH:mm:ss.sssZ)'),
      endTime: z
        .string()
        .describe('End time in ISO format (YYYY-MM-DDTHH:mm:ss.sssZ)'),
      type: z
        .string()
        .optional()
        .describe('Appointment type (CONSULTATION, FOLLOW_UP, EMERGENCY)'),
      mode: z
        .string()
        .optional()
        .describe('Appointment mode (VIRTUAL, IN_PERSON)'),
    });
    type BookAppointmentInput = z.infer<typeof bookAppointmentInputSchema>;

    const getMyAppointmentsInputSchema = z.object({
      userId: z.string().describe('ID of the user'),
      status: z
        .string()
        .optional()
        .describe(
          'Filter by appointment status (SCHEDULED, COMPLETED, CANCELLED)',
        ),
    });
    type GetMyAppointmentsInput = z.infer<typeof getMyAppointmentsInputSchema>;

    const cancelAppointmentInputSchema = z.object({
      appointmentId: z.string().describe('ID of the appointment to cancel'),
      reason: z.string().optional().describe('Reason for cancellation'),
    });
    type CancelAppointmentInput = z.infer<typeof cancelAppointmentInputSchema>;

    const getMyPrescriptionsInputSchema = z.object({
      userId: z.string().describe('ID of the user'),
      role: z.string().describe('User role (patient, doctor, pharmacist)'),
    });
    type GetMyPrescriptionsInput = z.infer<
      typeof getMyPrescriptionsInputSchema
    >;

    const getPrescriptionDetailsInputSchema = z.object({
      prescriptionId: z.string().describe('ID of the prescription'),
      userId: z.string().describe('ID of the user'),
      role: z.string().describe('User role (patient, doctor, pharmacist)'),
    });
    type GetPrescriptionDetailsInput = z.infer<
      typeof getPrescriptionDetailsInputSchema
    >;

    type ListDoctorsOutput = Awaited<ReturnType<ChatService['listDoctors']>>;
    type CheckDoctorAvailabilityOutput = Awaited<
      ReturnType<ChatService['handleDoctorAvailabilityByDay']>
    >;
    type ListAvailableDoctorsByDayOutput = Awaited<
      ReturnType<ChatService['listAvailableDoctorsByDay']>
    >;
    type BookAppointmentOutput = Awaited<
      ReturnType<ChatService['bookAppointment']>
    >;
    type GetMyAppointmentsOutput = Awaited<
      ReturnType<ChatService['getMyAppointments']>
    >;
    type CancelAppointmentOutput = Awaited<
      ReturnType<ChatService['cancelAppointment']>
    >;
    type GetMyPrescriptionsOutput = Awaited<
      ReturnType<ChatService['getMyPrescriptions']>
    >;
    type GetPrescriptionDetailsOutput = Awaited<
      ReturnType<ChatService['getPrescriptionDetails']>
    >;

    return {
      list_doctors: tool<ListDoctorsInput, ListDoctorsOutput>({
        description:
          'List all available doctors, optionally filtered by specialty',
        inputSchema: listDoctorsInputSchema,
        execute: async ({ specialty }: ListDoctorsInput) => {
          this.logger.log(
            `Executing list_doctors tool with specialty: ${specialty}`,
          );
          try {
            const result = await this.listDoctors(specialty);
            this.logger.log(
              `list_doctors completed with ${result.total} results`,
            );
            return result;
          } catch (error) {
            this.logger.error('Error in list_doctors tool:', error);
            return {
              success: false,
              error: 'Failed to fetch doctors list',
              message: error instanceof Error ? error.message : 'Unknown error',
              total: 0,
              doctors: [],
            };
          }
        },
      }),

      check_doctor_availability: tool<
        CheckDoctorAvailabilityInput,
        CheckDoctorAvailabilityOutput
      >({
        description:
          'Check available time slots for a specific doctor on a given day of the week',
        inputSchema: checkDoctorAvailabilityInputSchema,
        execute: async ({
          doctorName,
          dayOfWeek,
        }: CheckDoctorAvailabilityInput) => {
          this.logger.log(
            `Checking availability for ${doctorName} on ${dayOfWeek}`,
          );
          try {
            const result = await this.handleDoctorAvailabilityByDay(
              doctorName,
              dayOfWeek,
            );
            this.logger.log(`Doctor availability check completed`);
            return result;
          } catch (error) {
            this.logger.error(
              'Error in check_doctor_availability tool:',
              error,
            );
            return {
              success: false,
              error: 'Failed to check doctor availability',
              message: error instanceof Error ? error.message : 'Unknown error',
            };
          }
        },
      }),

      list_available_doctors_by_day: tool<
        ListAvailableDoctorsByDayInput,
        ListAvailableDoctorsByDayOutput
      >({
        description:
          'List doctors with availability on a specific day of the week, optionally filtered by specialty',
        inputSchema: listAvailableDoctorsByDayInputSchema,
        execute: async ({
          dayOfWeek,
          specialty,
        }: ListAvailableDoctorsByDayInput) => {
          this.logger.log(
            `Listing available doctors for ${dayOfWeek}, specialty: ${specialty}`,
          );
          try {
            const result = await this.listAvailableDoctorsByDay(
              dayOfWeek,
              specialty,
            );
            this.logger.log(
              `Available doctors by day completed with ${result.total} results`,
            );
            return result;
          } catch (error) {
            this.logger.error(
              'Error in list_available_doctors_by_day tool:',
              error,
            );
            return {
              success: false,
              error: 'Failed to fetch available doctors',
              message: error instanceof Error ? error.message : 'Unknown error',
              total: 0,
              doctors: [],
            };
          }
        },
      }),

      book_appointment: tool<BookAppointmentInput, BookAppointmentOutput>({
        description: 'Book an appointment with a doctor at a specific time',
        inputSchema: bookAppointmentInputSchema,
        execute: async ({
          doctorId,
          startTime,
          endTime,
          type,
          mode,
        }: BookAppointmentInput) => {
          this.logger.log(`Booking appointment with doctor ${doctorId}`);
          try {
            const result = await this.bookAppointment(
              doctorId,
              userContext,
              startTime,
              endTime,
              type,
              mode,
            );
            this.logger.log(
              `Appointment booking completed: ${result.appointmentId}`,
            );
            return result;
          } catch (error) {
            this.logger.error('Error in book_appointment tool:', error);
            return {
              success: false,
              appointmentId: '',
              message: error instanceof Error ? error.message : 'Unknown error',
              details: {
                doctorName: '',
                datetime: '',
                type: AppointmentType.CONSULTATION,
                mode: AppointmentMode.VIRTUAL,
                status: AppointmentStatus.CANCELLED,
              },
            };
          }
        },
      }),

      get_my_appointments: tool<
        GetMyAppointmentsInput,
        GetMyAppointmentsOutput
      >({
        description: 'Get all appointments for the current user',
        inputSchema: getMyAppointmentsInputSchema,
        execute: async ({ status }: GetMyAppointmentsInput) => {
          this.logger.log(`Getting appointments for user, status: ${status}`);
          try {
            const result = await this.getMyAppointments(
              userContext,
              status as AppointmentStatus,
            );
            this.logger.log(
              `Get appointments completed with ${result.total} results`,
            );
            return result;
          } catch (error) {
            this.logger.error('Error in get_my_appointments tool:', error);
            return {
              success: false,
              error: 'Failed to fetch appointments',
              message: error instanceof Error ? error.message : 'Unknown error',
              total: 0,
              appointments: [],
              role: userContext.role,
            };
          }
        },
      }),

      cancel_appointment: tool<CancelAppointmentInput, CancelAppointmentOutput>(
        {
          description: 'Cancel a specific appointment',
          inputSchema: cancelAppointmentInputSchema,
          execute: async ({
            appointmentId,
            reason,
          }: CancelAppointmentInput) => {
            this.logger.log(`Cancelling appointment: ${appointmentId}`);
            try {
              const result = await this.cancelAppointment(
                appointmentId,
                userContext,
                reason,
              );
              this.logger.log(`Appointment cancellation completed`);
              return result;
            } catch (error) {
              this.logger.error('Error in cancel_appointment tool:', error);
              return {
                success: false,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Failed to cancel appointment',
                appointmentId: appointmentId,
                reason: reason || 'Cancellation failed',
                cancelledBy: userContext.role || 'unknown',
              };
            }
          },
        },
      ),

      get_my_prescriptions: tool<
        GetMyPrescriptionsInput,
        GetMyPrescriptionsOutput
      >({
        description: 'Get all prescriptions for the current user',
        inputSchema: getMyPrescriptionsInputSchema,
        execute: async ({ role }: GetMyPrescriptionsInput) => {
          this.logger.log(`Getting prescriptions for user, role: ${role}`);
          try {
            const result = await this.getMyPrescriptions(
              userContext,
              role as UserRole,
            );
            this.logger.log(
              `Get prescriptions completed with ${result.total} results`,
            );
            return result;
          } catch (error) {
            this.logger.error('Error in get_my_prescriptions tool:', error);
            return {
              success: false,
              error: 'Failed to fetch prescriptions',
              message: error instanceof Error ? error.message : 'Unknown error',
              total: 0,
              prescriptions: [],
              role: userContext.role,
            };
          }
        },
      }),

      get_prescription_details: tool<
        GetPrescriptionDetailsInput,
        GetPrescriptionDetailsOutput
      >({
        description: 'Get detailed information about a specific prescription',
        inputSchema: getPrescriptionDetailsInputSchema,
        execute: async ({
          prescriptionId,
          role,
        }: GetPrescriptionDetailsInput) => {
          this.logger.log(`Getting prescription details: ${prescriptionId}`);
          try {
            const result = await this.getPrescriptionDetails(
              prescriptionId,
              userContext,
              role as UserRole,
            );
            this.logger.log(`Get prescription details completed`);
            return result;
          } catch (error) {
            this.logger.error('Error in get_prescription_details tool:', error);
            return {
              success: false,
              id: '',
              issueDate: new Date(),
              expiryDate: new Date(),
              isFulfilled: false,
              items: [],
              patient: { name: '', id: '' },
              doctor: { name: '', id: '' },
              pharmacist: null,
              accessedBy:
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch prescription details',
            };
          }
        },
      }),
    };
  }

  private getSystemMessage(userContext: UserContext) {
    const currentDate = new Date().toISOString().split('T')[0];
    const currentDay = new Date().toLocaleDateString('en-US', {
      weekday: 'long',
    });

    return {
      role: 'system' as const,
      content: `You are Krista, a warm and empathetic AI medical assistant for NineHertz Medic Application. You help users with medical appointments, prescriptions, and healthcare management in a friendly, human-like manner.

IMPORTANT USER CONTEXT:
- Current user ID: ${userContext.userId}
- User role: ${userContext.role}
- Today's date is ${currentDate} (${currentDay})
- When users ask about doctor availability, use days of the week (Monday, Tuesday, etc.)

PERSONALITY & COMMUNICATION STYLE:
- Be warm, empathetic, and conversational
- Keep responses concise and helpful
- Never overwhelm users with multiple questions
- Provide helpful guidance without being pushy
- Show understanding for user needs and concerns
- Use friendly language like "I'd be happy to help" or "Let me assist you with that"

ROLE-BASED PERMISSIONS:
PATIENTS can:
- Book appointments for themselves
- View their own appointments
- View their own prescriptions
- Check doctor availability

DOCTORS can:
- View their appointments
- View prescriptions they wrote
- Check their schedule
- Cannot book appointments for patients

PHARMACISTS can:
- Manage prescriptions
- View medicine information
- Process orders

ADMINS can:
- View system data
- Manage appointments (view only, not book)
- Access all information but with restrictions

APPOINTMENT BOOKING RULES:
- Appointments are 30-minute slots only
- Accept time inputs like "4:30", "2:00", "10:30" (automatically add 30 minutes)
- Valid times: 8:00 AM - 5:30 PM (30-minute intervals)
- Never ask users to confirm doctor IDs (system handles this internally)
- If user provides invalid time, suggest nearest valid slot

APPOINTMENT BOOKING FLOW:
1. When user wants to book: "I'd be happy to help you book an appointment! Which doctor would you like to see?"
2. After doctor selection: "Great choice! What day would work best for you?"
3. After day selection: "Perfect! What time would you prefer?"
4. Complete booking with minimal confirmation

ERROR HANDLING & GUIDANCE:
- For permission issues: Explain role limitations clearly
- For unavailable features: Suggest appropriate alternatives
- If confused about user intent: Make a smart assumption and offer gentle correction if wrong

CONVERSATION EXAMPLES:
User: "I need to see a cardiologist"
Response: "I'd be happy to help you find a cardiologist! Let me show you available cardiac specialists."

User: "Book appointment at 4:30"
Response: "Perfect! I'll book your 30-minute appointment from 4:30-5:00. Which doctor would you like to see?"

RULES:
1. Use ONLY provided tools for medical queries
2. Book appointments with minimal friction - don't ask unnecessary questions
3. Be proactive in offering help
4. Keep responses warm, helpful, and concise
5. Never overwhelm with options - provide focused assistance
6. Always respect role-based permissions

You are here to make healthcare management simple and stress-free for users while respecting their role permissions.`,
    };
  }

  private async listDoctors(specialty?: string): Promise<{
    success: boolean;
    message?: string;
    specialty?: string;
    total: number;
    doctors: Array<{
      id: string;
      name: string;
      specialty: string;
      appointmentFee: number;
      status: string;
    }>;
    summary?: string;
  }> {
    try {
      const filter: DoctorFilterDto = {};
      if (specialty) {
        filter.specialty = this.normalizeSpecialty(specialty);
      }

      const pagination: PaginationDto = { page: 1, limit: 50 };
      const doctors = await this.doctorService.findAll(pagination, filter);

      if (!doctors.data?.length) {
        return {
          success: false,
          message: specialty
            ? `No ${specialty} specialists found`
            : 'No doctors found',
          total: 0,
          doctors: [],
        };
      }

      return {
        success: true,
        specialty,
        total: doctors.total,
        doctors: doctors.data.map((doctor) => ({
          id: doctor.id,
          name: doctor.fullName,
          specialty: doctor.specialty,
          appointmentFee: doctor.appointmentFee,
          status: doctor.status,
        })),
        summary: `Found ${doctors.total} ${specialty ? specialty + ' ' : ''}doctor${doctors.total > 1 ? 's' : ''}: ${doctors.data.map((d) => d.fullName).join(', ')}`,
      };
    } catch (error) {
      this.logger.error('Error listing doctors:', error);
      throw new Error('Failed to retrieve doctors list');
    }
  }

  private async listAvailableDoctorsByDay(
    dayOfWeek: string,
    specialty?: string,
  ): Promise<{
    success: boolean;
    message?: string;
    total: number;
    doctors: Array<{
      id: string;
      name: string;
      specialty: string;
      appointmentFee: number;
      availableSlots: number;
      sampleTimeSlots: string[];
    }>;
    dayOfWeek?: string;
    specialty?: string;
    summary?: string;
  }> {
    const normalizedDay = this.normalizeDayOfWeek(dayOfWeek);

    if (!this.isValidDayOfWeek(normalizedDay)) {
      throw new Error(
        'Invalid day of week. Please use Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, or Sunday.',
      );
    }

    try {
      const filter: DoctorFilterDto = {};
      if (specialty) {
        filter.specialty = this.normalizeSpecialty(specialty);
      }

      const pagination: PaginationDto = { page: 1, limit: 50 };
      const doctors = await this.doctorService.findAll(pagination, filter);

      if (!doctors.data?.length) {
        return {
          success: false,
          message: specialty
            ? `No ${specialty} specialists found`
            : 'No doctors found',
          total: 0,
          doctors: [],
        };
      }

      const availableDoctors: Array<{
        id: string;
        name: string;
        specialty: string;
        appointmentFee: number;
        availableSlots: number;
        sampleTimeSlots: string[];
      }> = [];

      for (const doctor of doctors.data) {
        try {
          const availability = await this.doctorService.getDoctorAvailability(
            doctor.id,
            { dayOfWeek: normalizedDay as DaysOfWeek },
          );

          if (
            availability.availableSlots &&
            availability.availableSlots.length > 0
          ) {
            availableDoctors.push({
              id: doctor.id,
              name: doctor.fullName,
              specialty: doctor.specialty,
              appointmentFee: doctor.appointmentFee,
              availableSlots: availability.availableSlots.length,
              sampleTimeSlots: availability.availableSlots
                .slice(0, 3)
                .map((slot) => `${slot.start}-${slot.end}`),
            });
          }
        } catch (error) {
          this.logger.warn(
            `Failed to get availability for doctor ${doctor.id}:`,
            error,
          );
          continue;
        }
      }

      if (!availableDoctors.length) {
        return {
          success: false,
          message: specialty
            ? `No ${specialty} specialists available on ${normalizedDay}`
            : `No doctors available on ${normalizedDay}`,
          total: 0,
          doctors: [],
        };
      }

      return {
        success: true,
        dayOfWeek: normalizedDay,
        specialty,
        total: availableDoctors.length,
        doctors: availableDoctors,
        summary: `Found ${availableDoctors.length} available ${specialty ? specialty + ' ' : ''}doctor${availableDoctors.length > 1 ? 's' : ''} on ${normalizedDay}: ${availableDoctors.map((d) => d.name).join(', ')}`,
      };
    } catch (error) {
      this.logger.error('Error listing available doctors by day:', error);
      throw new Error('Failed to retrieve available doctors');
    }
  }

  private async handleDoctorAvailabilityByDay(
    doctorName: string,
    dayOfWeek: string,
  ): Promise<{
    success: boolean;
    message?: string;
    doctorId?: string;
    doctorName?: string;
    dayOfWeek?: string;
    availableSlots?: Array<{ start: string; end: string }>;
    busySlots?: Array<{ start: string; end: string }>;
    totalAvailable?: number;
    summary?: string;
  }> {
    if (!doctorName || !dayOfWeek) {
      throw new Error('Doctor name and day of week are required');
    }

    const normalizedDay = this.normalizeDayOfWeek(dayOfWeek);

    if (!this.isValidDayOfWeek(normalizedDay)) {
      throw new Error(
        'Invalid day of week. Please use Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, or Sunday.',
      );
    }

    try {
      const pagination: PaginationDto = { page: 1, limit: 1 };
      const doctorsResponse = await this.doctorService.findAll(pagination, {
        fullName: doctorName,
      } as DoctorFilterDto);

      if (
        !doctorsResponse ||
        !Array.isArray(doctorsResponse.data) ||
        doctorsResponse.data.length === 0
      ) {
        return {
          success: false,
          message: `No doctor found with name: ${doctorName}`,
        };
      }

      const doctor = doctorsResponse.data[0];

      const availability = await this.doctorService.getDoctorAvailability(
        doctor.id,
        { dayOfWeek: normalizedDay as DaysOfWeek },
      );

      if (!availability.availableSlots?.length) {
        return {
          success: false,
          message: `Dr. ${doctor.fullName} has no available slots on ${normalizedDay}`,
          doctorId: doctor.id,
          doctorName: doctor.fullName,
          dayOfWeek: normalizedDay,
        };
      }

      const timeSlots = availability.availableSlots.map(
        (slot) => `${slot.start}-${slot.end}`,
      );

      return {
        success: true,
        doctorId: doctor.id,
        doctorName: doctor.fullName,
        dayOfWeek: normalizedDay,
        availableSlots: availability.availableSlots,
        busySlots: availability.busySlots || [],
        totalAvailable: availability.availableSlots.length,
        summary: `Dr. ${doctor.fullName} has ${availability.availableSlots.length} available slot${availability.availableSlots.length > 1 ? 's' : ''} on ${normalizedDay}: ${timeSlots.slice(0, 5).join(', ')}${timeSlots.length > 5 ? '...' : ''}`,
      };
    } catch (error) {
      this.logger.error(`Error checking doctor availability:`, error);
      throw new Error(
        `Unable to check availability for Dr. ${doctorName}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  private async bookAppointment(
    doctorId: string,
    userContext: UserContext,
    startTime: string,
    endTime: string,
    type?: string,
    mode?: string,
  ): Promise<{
    success: boolean;
    appointmentId: string;
    message: string;
    details: {
      doctorName: string;
      datetime: string;
      type: AppointmentType;
      mode: AppointmentMode;
      status: AppointmentStatus;
    };
  }> {
    if (userContext.role !== UserRole.PATIENT) {
      throw new Error(
        `Only patients can book appointments. Your current role is '${userContext.role}'.`,
      );
    }

    if (!userContext.patientId) {
      throw new Error(
        'Patient profile not found. Please ensure you have a valid patient account.',
      );
    }

    if (!doctorId || !startTime || !endTime) {
      throw new Error('Doctor ID, start time, and end time are required');
    }

    try {
      const start = new Date(startTime);
      const end = new Date(endTime);

      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        throw new Error(
          'Invalid date format provided. Please use ISO format (YYYY-MM-DDTHH:mm:ss.sssZ)',
        );
      }

      const now = new Date();
      if (start < now) {
        throw new Error('Cannot book appointments in the past');
      }

      if (start >= end) {
        throw new Error('Start time must be before end time');
      }

      const doctor = await this.doctorService.findOne(doctorId);
      if (!doctor) {
        throw new Error('Doctor not found');
      }

      const appointment = await this.appointmentService.create({
        patientId: userContext.patientId,
        doctorId,
        datetime: start,
        endTime: end,
        startTime: start,
        status: AppointmentStatus.SCHEDULED,
        type: (type as AppointmentType) || AppointmentType.CONSULTATION,
        mode: (mode as AppointmentMode) || AppointmentMode.VIRTUAL,
      });

      return {
        success: true,
        appointmentId: appointment.id,
        message: `Appointment booked successfully for ${start.toLocaleString()}`,
        details: {
          doctorName: appointment.doctor?.fullName || doctor.fullName,
          datetime: start.toLocaleString(),
          type: appointment.type,
          mode: appointment.mode,
          status: appointment.status,
        },
      };
    } catch (error) {
      this.logger.error('Error booking appointment:', error);
      throw error;
    }
  }

  private async getMyAppointments(
    userContext: UserContext,
    status?: AppointmentStatus,
  ): Promise<{
    success: boolean;
    message?: string;
    total: number;
    appointments: Array<{
      id: string;
      datetime: Date | string;
      status: AppointmentStatus;
      type: AppointmentType;
      mode: AppointmentMode;
      doctorName?: string;
      patientName?: string;
    }>;
    role: string;
    summary?: string;
  }> {
    try {
      const filter: { status?: AppointmentStatus } = {};
      if (status) {
        filter.status = status;
      }

      const pagination: PaginationDto = { page: 1, limit: 50 };

      let appointments: {
        data: Array<{
          id: string;
          datetime: Date | string;
          status: AppointmentStatus;
          type: AppointmentType;
          mode: AppointmentMode;
          doctor?: { fullName: string };
          patient?: { fullName: string };
        }>;
        total: number;
      };

      if (userContext.role === UserRole.PATIENT && userContext.patientId) {
        appointments = await this.appointmentService.findAll(
          pagination,
          filter,
          userContext.userId,
          'patient',
        );
      } else if (userContext.role === UserRole.DOCTOR && userContext.doctorId) {
        appointments = await this.appointmentService.findAll(
          pagination,
          filter,
          userContext.userId,
          'doctor',
        );
      } else if (userContext.role === UserRole.ADMIN) {
        appointments = await this.appointmentService.findAll(
          pagination,
          filter,
          userContext.userId,
          'admin',
        );
      } else {
        throw new Error(
          `Unable to retrieve appointments for role: ${userContext.role}`,
        );
      }

      if (!appointments.data?.length) {
        return {
          success: true,
          message: `No ${status ? status.toLowerCase() + ' ' : ''}appointments found`,
          total: 0,
          appointments: [],
          role: userContext.role,
        };
      }

      return {
        success: true,
        total: appointments.total,
        role: userContext.role,
        appointments: appointments.data.map((apt) => ({
          id: apt.id,
          datetime: apt.datetime,
          status: apt.status,
          type: apt.type,
          mode: apt.mode,
          doctorName: apt.doctor?.fullName,
          patientName: apt.patient?.fullName,
        })),
        summary: `Found ${appointments.total} ${status ? status.toLowerCase() + ' ' : ''}appointment${appointments.total > 1 ? 's' : ''}`,
      };
    } catch (error) {
      this.logger.error('Error getting appointments:', error);
      throw error;
    }
  }

  private async cancelAppointment(
    appointmentId: string,
    userContext: UserContext,
    reason?: string,
  ): Promise<{
    success: boolean;
    message: string;
    appointmentId: string;
    reason: string;
    cancelledBy: string;
  }> {
    if (!appointmentId) {
      throw new Error('Appointment ID is required');
    }

    try {
      if (userContext.role === UserRole.PATIENT) {
        const appointment =
          await this.appointmentService.findOne(appointmentId);
        if (!appointment) {
          throw new Error('Appointment not found');
        }
        if (appointment.patient?.user.id !== userContext.userId) {
          throw new Error('You can only cancel your own appointments');
        }
      } else if (userContext.role === UserRole.DOCTOR) {
        const appointment =
          await this.appointmentService.findOne(appointmentId);
        if (!appointment) {
          throw new Error('Appointment not found');
        }
        if (appointment.doctor?.user.id !== userContext.userId) {
          throw new Error('You can only cancel appointments assigned to you');
        }
      }

      const cancelledAppointment =
        await this.appointmentService.cancelAppointment(appointmentId, reason);

      return {
        success: true,
        message: 'Appointment cancelled successfully',
        appointmentId: cancelledAppointment.id,
        reason: reason || 'No reason provided',
        cancelledBy: userContext.role || 'unknown',
      };
    } catch (error) {
      this.logger.error('Error cancelling appointment:', error);
      throw error;
    }
  }

  private async getMyPrescriptions(
    userContext: UserContext,
    role: UserRole,
  ): Promise<{
    success: boolean;
    message?: string;
    total: number;
    prescriptions: Array<{
      id: string;
      issueDate: Date;
      expiryDate: Date;
      isFulfilled: boolean;
      patientName?: string;
      doctorName?: string;
      pharmacistName?: string;
      itemsCount: number;
    }>;
    role: UserRole;
    summary?: string;
  }> {
    const effectiveRole = role || userContext.role;

    if (!effectiveRole) {
      throw new Error('User role is required to retrieve prescriptions');
    }

    if (
      userContext.role === UserRole.ADMIN &&
      effectiveRole !== UserRole.ADMIN
    ) {
      throw new Error(
        'As an admin, you can view system data but cannot access role-specific prescriptions directly. Please specify the correct role parameter.',
      );
    }

    try {
      const prescriptions = await this.prescriptionService.findAll(
        userContext.userId,
        effectiveRole,
      );

      if (!prescriptions?.length) {
        return {
          success: true,
          message: 'No prescriptions found',
          total: 0,
          prescriptions: [],
          role: effectiveRole,
        };
      }

      return {
        success: true,
        total: prescriptions.length,
        role: effectiveRole,
        prescriptions: prescriptions.map((p) => ({
          id: p.id,
          issueDate: p.issueDate,
          expiryDate: p.expiryDate,
          isFulfilled: p.isFulfilled,
          patientName: p.patient?.fullName,
          doctorName: p.prescribedBy?.fullName,
          pharmacistName: p.fulfilledBy?.fullName,
          itemsCount: p.items?.length || 0,
        })),
        summary: `Found ${prescriptions.length} prescription${prescriptions.length > 1 ? 's' : ''}`,
      };
    } catch (error) {
      this.logger.error('Error getting prescriptions:', error);
      throw error;
    }
  }

  private async getPrescriptionDetails(
    prescriptionId: string,
    userContext: UserContext,
    role: UserRole,
  ): Promise<{
    success: boolean;
    id: string;
    issueDate: Date;
    expiryDate: Date;
    isFulfilled: boolean;
    items: any[];
    patient: { name: string; id: string };
    doctor: { name: string; id: string };
    pharmacist: { name: string; id: string } | null;
    accessedBy: string;
  }> {
    if (!prescriptionId) {
      throw new Error('Prescription ID is required');
    }

    const effectiveRole = role || userContext.role;

    if (!effectiveRole) {
      throw new Error('User role is required to retrieve prescription details');
    }

    if (
      userContext.role === UserRole.ADMIN &&
      effectiveRole !== UserRole.ADMIN
    ) {
      throw new Error(
        'As an admin, you can view system data but cannot access role-specific prescription details directly. Please specify the correct role parameter.',
      );
    }

    try {
      const prescription = await this.prescriptionService.findOne(
        prescriptionId,
        userContext.userId,
        effectiveRole,
      );

      if (!prescription) {
        throw new Error(
          'Prescription not found or you do not have permission to view it',
        );
      }

      return {
        success: true,
        id: prescription.id,
        issueDate: prescription.issueDate,
        expiryDate: prescription.expiryDate,
        isFulfilled: prescription.isFulfilled,
        items: prescription.items,
        patient: {
          name: prescription.patient?.fullName,
          id: prescription.patient?.id,
        },
        doctor: {
          name: prescription.prescribedBy?.fullName,
          id: prescription.prescribedBy?.id,
        },
        pharmacist: prescription.fulfilledBy
          ? {
              name: prescription.fulfilledBy.fullName,
              id: prescription.fulfilledBy.id,
            }
          : null,
        accessedBy: effectiveRole,
      };
    } catch (error) {
      this.logger.error('Error getting prescription details:', error);
      throw error;
    }
  }
}
